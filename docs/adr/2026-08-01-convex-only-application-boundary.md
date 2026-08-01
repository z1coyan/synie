# ADR：Convex-only 应用边界与旧后端退役

2026-08-01，状态：已实施。

## 背景

项目尚未上线，没有生产用户、法定账务、正式附件或必须搬迁的业务数据。迁移计划 001–007 已在
固定版本的自托管 Convex、PostgreSQL 17、私有 S3/MinIO 与 TanStack Start production container 上
验证认证、领域事务、事实/投影、外部 I/O、备份恢复和 PDF。因此继续保留独立业务服务只会制造两套
权威、transport 与运维路径，不提供数据迁移价值。

## 决策

- Convex query/mutation/action、schema、事实与投影是业务数据、授权、事务、任务和调度的唯一权威。
- 浏览器业务调用只通过 generated Convex API 与 ResourceBinding。Better Auth 使用 TanStack Start
  同源 Cookie 路由；产品文件通过 Convex 鉴权后使用私有 S3 短时 URL。
- TanStack Start 只承载 SSR、Better Auth 接线和带 HMAC 的内部 xlsx→PDF Worker。Worker 不读取业务
  数据，也不成为 CRUD 或领域命令入口。
- 独立 Bun/Hono/Kysely 服务、业务 SQL migrations、业务 PostgreSQL Compose service、JWT 浏览器
  token、业务 REST transport、迁移模式与 fallback 全部退役；工作树不保留半套兼容实现。
- 不建设 SQL→Convex importer、CDC 或双写。新部署从空的 Convex deployment 运行 Setup；若未来发现
  必须保留的数据，必须另立数据迁移 ADR，不得恢复隐式双轨。

## Setup 的最终事务边界

首用户 mutation 在一个 Convex transaction 中跨 Better Auth component 与应用表创建 principal、
credential、ERP Actor、`setupState` 和常用币种。业务底座由首管理员认证 mutation 原子创建首公司、
本币、三仓、科目、单位、分类、角色、设置和编号规则。可选示例数据由 action 编排七个原子阶段；
阶段只在完整成功后推进恢复点，全部阶段完成后才写 `completedAt`。重复调用已完成 action 不改变数据。

## 恢复与回滚

当前恢复单元是 Convex snapshot/PostgreSQL、五个 Convex bucket、产品 bucket、函数 Git SHA 与 deployment
secret reference；必须配对备份和恢复。删除后的旧 release 只由 annotated tag `server-bun-final`
整体恢复，不能从当前树局部复活。任何停止命令默认保留 Docker volume 与 bucket。

## 架构门禁

`check:convex-cutover-readiness` 固定资源、旧表、事务闭包、外部 I/O 与 Web binding 分母；
`check:no-legacy-server` 阻止旧 workspace、业务 REST、旧 token、业务数据库变量和进程模式重入。
新资源或 table-like collection 必须更新 coverage manifest，并提供 Convex target 与行为测试。

## 关联决策与证据

- [自托管 Convex 平台](2026-07-31-self-hosted-convex-platform.md)
- [Better Auth 与 ERP Actor](2026-07-31-convex-auth-and-actor.md)
- [Convex 事实与投影](2026-07-31-convex-facts-and-projections.md)
- [私有 S3 与外部 I/O](2026-07-31-s3-files-and-convex-actions.md)
- [Convex 打印调度与 PDF Worker](2026-07-31-convex-print-worker.md)
- [迁移完成记录](../migration/2026-07-31-bun-server-to-self-hosted-convex-cutover.md)

本 ADR 取代旧 ADR 中将独立业务服务、REST Adapter 或迁移模式描述为当前运行面的技术段落；那些文档
仍保留为决策演进记录，其领域原则继续有效。
