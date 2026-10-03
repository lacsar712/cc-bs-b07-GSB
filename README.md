# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 跨中S1 | 170 με | 合格 |
| 支座S2 | 40 με | 越界 |

两笔「跨中S1」合格点可在「合成均值」专页勾选，由服务端算均值（160 με）写入新候审单，合成记录落在 `strain_merges` 流水表。

## 合成均值接口

| 接口 | 权限 | 说明 |
|------|------|------|
| `POST /api/readings/merge-preview` | 登录用户 | 服务端核算均值预览，不写库；复核员可用 |
| `POST /api/readings/merge` | 仅测量员 | 服务端 `AVG` 求均值，同事务写入 pending 新单与合成流水 |
| `GET /api/merge-records` | 登录用户 | 合成流水列表 |

校验：至少两个测点、全部 `done`、跨段编号一致；不满足返回 400。前端不做任何平均计算。

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
