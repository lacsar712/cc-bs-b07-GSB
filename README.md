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

## 合成均值入队

测量员可将**至少两个同一跨段、且均已办结（done）**的测点合成一笔均值新单：

1. 顶栏进入「合成均值」专页，按跨段分组勾选已办结测点；
2. 勾选后页面调用预览接口，**均值由服务端 `AVG` 计算**并展示，前端不做任何平均；
3. 测量员点「按均值入队」，服务端在单事务内：锁定源行（`FOR UPDATE`）→ 复核校验 → 以服务端均值写入一笔 `pending` 候审单 → 同步写入 `strain_compositions` 合成流水（入队与流水同生共死）；
4. 新单进入原候审队列，由后台工人按同一套 80～220 με 规则判定。

挡回规则（服务端强制，前端限制仅为体验）：

- 勾选少于两个测点 → 400；
- 点集含不存在或未办结（`pending`/`processing`）的测点 → 400；
- 点集跨跨段（不同类）→ 400；
- 复核员调用入队接口 → 403（复核员在专页可勾选并预览均值，但无入队按钮）。

| 接口 | 权限 | 说明 |
|------|------|------|
| `POST /api/readings/composite/preview` | 登录 | 入参 `{"ids":[...]}`，返回源测点与 `mean_microstrain` |
| `POST /api/readings/composite` | 测量员 | 同样入参，服务端算均值，新单与合成流水一并落库，返回新候审单 |

读数列表的「来源」列对合成单显示其源测点编号，合成流水记录于 `strain_compositions` 表。

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
