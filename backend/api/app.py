import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT r.id, r.span_code, r.microstrain, r.verdict, r.reason,
                       r.status, r.created_by, r.created_at, r.processed_at,
                       (SELECT c.source_ids
                          FROM strain_compositions c
                         WHERE c.new_reading_id = r.id
                         LIMIT 1) AS composed_from
                FROM strain_readings r
                ORDER BY r.id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
                "composed_from": list(r["composed_from"] or []),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


def _parse_ids(body) -> list[int] | None:
    raw = body.get("ids")
    if not isinstance(raw, list):
        return None
    ids = set()
    for value in raw:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        ids.add(value)
    return sorted(ids)


async def _load_composite_sources(cur, ids: list[int], lock: bool):
    """按 id 加载源测点；lock=True 时 FOR UPDATE 锁定，供入队事务使用。"""
    sql = """
        SELECT id, span_code, microstrain, verdict, reason, status,
               created_by, created_at, processed_at
        FROM strain_readings
        WHERE id = ANY(%s)
        ORDER BY id
    """
    if lock:
        sql += " FOR UPDATE"
    await cur.execute(sql, (ids,))
    return await cur.fetchall()


def _validate_sources(ids: list[int], rows) -> tuple[list, str | None]:
    """合成前置校验：数量充足、全部已办结、全部同类（同一跨段）。"""
    if len(ids) < 2:
        return [], "至少勾选两个测点才能合成均值"
    if len(rows) != len(ids):
        return [], "勾选的测点中有不存在的记录"
    not_done = [r for r in rows if r["status"] != "done"]
    if not_done:
        return [], "点集包含未办结测点，只能合成已办结（done）的读数"
    span_codes = {r["span_code"] for r in rows}
    if len(span_codes) != 1:
        return [], "只能合成同一跨段（同类）的测点"
    return rows, None


def _serialize_source(r) -> dict:
    return {
        "id": r["id"],
        "span_code": r["span_code"],
        "microstrain": r["microstrain"],
        "verdict": r["verdict"],
        "reason": r["reason"],
        "status": r["status"],
        "created_by": r["created_by"],
        "created_at": _iso(r["created_at"]),
        "processed_at": _iso(r["processed_at"]),
    }


@app.post("/api/readings/composite/preview")
async def composite_preview(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    ids = _parse_ids(request.json or {})
    if ids is None:
        return sanic_json({"detail": "ids 必须是测点编号数组"}, status=400)
    if len(ids) < 2:
        return sanic_json({"detail": "至少勾选两个测点才能合成均值"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            rows = await _load_composite_sources(cur, ids, lock=False)
            sources, error = _validate_sources(ids, rows)
            if error:
                return sanic_json({"detail": error}, status=400)
            # 均值只在服务端计算，前端只负责勾选。
            await cur.execute(
                "SELECT AVG(microstrain) AS mean FROM strain_readings WHERE id = ANY(%s)",
                (ids,),
            )
            mean = float((await cur.fetchone())["mean"])

    return sanic_json(
        {
            "span_code": sources[0]["span_code"],
            "count": len(sources),
            "source_ids": [r["id"] for r in sources],
            "sources": [_serialize_source(r) for r in sources],
            "mean_microstrain": mean,
        }
    )


@app.post("/api/readings/composite")
async def create_composite(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可将合成均值入队"}, status=403)
    ids = _parse_ids(request.json or {})
    if ids is None:
        return sanic_json({"detail": "ids 必须是测点编号数组"}, status=400)
    if len(ids) < 2:
        return sanic_json({"detail": "至少勾选两个测点才能合成均值"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                # 锁定源行，阻止其在校验与写入之间被改动
                rows = await _load_composite_sources(cur, ids, lock=True)
                sources, error = _validate_sources(ids, rows)
                if error:
                    return sanic_json({"detail": error}, status=400)
                await cur.execute(
                    "SELECT AVG(microstrain) AS mean FROM strain_readings WHERE id = ANY(%s)",
                    (ids,),
                )
                mean = float((await cur.fetchone())["mean"])
                span_code = sources[0]["span_code"]

                await cur.execute(
                    """
                    INSERT INTO strain_readings
                        (span_code, microstrain, status, created_by, created_at)
                    VALUES (%s, %s, 'pending', %s, now())
                    RETURNING id, span_code, microstrain, verdict, reason, status,
                              created_by, created_at, processed_at
                    """,
                    (span_code, mean, user["username"]),
                )
                new_row = await cur.fetchone()

                await cur.execute(
                    """
                    INSERT INTO strain_compositions
                        (new_reading_id, span_code, mean_microstrain,
                         source_ids, created_by, created_at)
                    VALUES (%s, %s, %s, %s, %s, now())
                    """,
                    (new_row["id"], span_code, mean, ids, user["username"]),
                )

    return sanic_json(
        {
            "id": new_row["id"],
            "span_code": new_row["span_code"],
            "microstrain": new_row["microstrain"],
            "verdict": None,
            "reason": None,
            "status": new_row["status"],
            "created_by": new_row["created_by"],
            "created_at": _iso(new_row["created_at"]),
            "processed_at": None,
            "composed_from": ids,
            "mean_microstrain": mean,
            "message": "合成均值已入队，后台工人将认领并判定",
        },
        status=201,
    )
