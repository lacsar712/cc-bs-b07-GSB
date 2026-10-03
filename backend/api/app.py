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


class _MergeRejected(Exception):
    """合成校验未通过：触发事务回滚并以 400 返回中文原因。"""


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


def _reading_out(r) -> dict:
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
        "merge_id": r.get("merge_id"),
        "merged": r.get("merge_id") is not None,
    }


def _parse_ids(body) -> list[int] | None:
    raw = body.get("reading_ids")
    if not isinstance(raw, list):
        return None
    try:
        ids = [int(x) for x in raw]
    except (TypeError, ValueError):
        return None
    return list(dict.fromkeys(ids))


async def _collect_merge_sources(cur, ids: list[int], lock: bool):
    """服务端核验收测点：存在、全部已办结、同类（跨段一致），并用 SQL 算均值。

    返回 (sources, span_code, mean)；校验不过返回 (error_message, None, None)。
    """
    suffix = " FOR UPDATE" if lock else ""
    await cur.execute(
        f"""
        SELECT id, span_code, microstrain, verdict, status
        FROM strain_readings
        WHERE id = ANY(%s)
        ORDER BY id{suffix}
        """,
        (ids,),
    )
    rows = await cur.fetchall()
    if len(rows) != len(ids):
        return "存在无效或已删除的测点，请刷新后重试", None, None
    open_row = next((r for r in rows if r["status"] != "done"), None)
    if open_row:
        return (
            f"测点 #{open_row['id']} 尚未办结（状态 {open_row['status']}），不能参与合成",
            None,
            None,
        )
    span_codes = {r["span_code"] for r in rows}
    if len(span_codes) > 1:
        return "所选测点跨段编号不一致，仅同类测点可合成均值", None, None
    await cur.execute(
        "SELECT AVG(microstrain) AS mean FROM strain_readings WHERE id = ANY(%s)",
        (ids,),
    )
    mean = float((await cur.fetchone())["mean"])
    return rows, rows[0]["span_code"], mean



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
                       m.id AS merge_id
                FROM strain_readings r
                LEFT JOIN strain_merges m ON m.new_reading_id = r.id
                ORDER BY r.id DESC
                """
            )
            rows = await cur.fetchall()
    out = [_reading_out(r) for r in rows]
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

    out = _reading_out(row)
    out["message"] = "已入队，后台工人将认领并判定"
    return sanic_json(out, status=201)


@app.post("/api/readings/merge-preview")
async def merge_preview(request):
    """复核员可预览：服务端按所选测点计算均值，不写任何数据。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    body = request.json or {}
    ids = _parse_ids(body)
    if ids is None:
        return sanic_json({"detail": "reading_ids 必须是测点编号数组"}, status=400)
    if len(ids) < 2:
        return sanic_json({"detail": "至少勾选两个已办结同类测点"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            sources, span_code, mean = await _collect_merge_sources(
                cur, ids, lock=False
            )
    if span_code is None:
        return sanic_json({"detail": sources}, status=400)
    return sanic_json(
        {
            "span_code": span_code,
            "mean_microstrain": mean,
            "count": len(sources),
            "sources": [
                {
                    "id": r["id"],
                    "span_code": r["span_code"],
                    "microstrain": r["microstrain"],
                    "verdict": r["verdict"],
                }
                for r in sources
            ],
        }
    )


@app.post("/api/readings/merge")
async def merge_readings(request):
    """测量员专用：服务端锁定源测点、SQL 求均值，新候审单与合成流水同一事务落库。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可合成均值并入队"}, status=403)
    body = request.json or {}
    ids = _parse_ids(body)
    if ids is None:
        return sanic_json({"detail": "reading_ids 必须是测点编号数组"}, status=400)
    if len(ids) < 2:
        return sanic_json({"detail": "至少勾选两个已办结同类测点"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        try:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    sources, span_code, mean = await _collect_merge_sources(
                        cur, ids, lock=True
                    )
                    if span_code is None:
                        # 事务回滚，校验信息随 400 返回
                        raise _MergeRejected(sources)
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
                        INSERT INTO strain_merges
                            (source_ids, span_code, mean_microstrain,
                             new_reading_id, created_by, created_at)
                        VALUES (%s, %s, %s, %s, %s, now())
                        RETURNING id, source_ids, span_code, mean_microstrain,
                                  new_reading_id, created_by, created_at
                        """,
                        (ids, span_code, mean, new_row["id"], user["username"]),
                    )
                    merge_row = await cur.fetchone()
        except _MergeRejected as exc:
            return sanic_json({"detail": str(exc)}, status=400)

    out = _reading_out(new_row)
    out["merge_id"] = merge_row["id"]
    out["merged"] = True
    out["message"] = (
        f"已按服务端均值 {mean:g} με 合成新候审单 #{new_row['id']}，等待后台判定"
    )
    return sanic_json(out, status=201)


@app.get("/api/merge-records")
async def list_merge_records(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, source_ids, span_code, mean_microstrain,
                       new_reading_id, created_by, created_at
                FROM strain_merges
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    return sanic_json(
        [
            {
                "id": r["id"],
                "source_ids": list(r["source_ids"] or []),
                "span_code": r["span_code"],
                "mean_microstrain": r["mean_microstrain"],
                "new_reading_id": r["new_reading_id"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
            }
            for r in rows
        ]
    )
