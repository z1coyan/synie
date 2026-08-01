# 自托管 Convex 后端迁移实施计划

由 `improve` 技能于 2026-07-31 生成，勘察基线为 commit `2da55d9`。本目录使用
`advisor-plans/`，因为仓库现有 `plans/` 已用于打印引擎的独立实施计划。

执行者必须完整阅读待执行计划，按依赖顺序实施，逐条运行验证命令；遇到计划内的
STOP 条件时停止并报告，不得自行扩大范围。每完成一项，将本表对应状态更新为 `DONE`。

## 勘察结论

**可行，而且适合这个项目以“单一后端事实源”降低维护成本。** 现有 Bun/Hono/Kysely 后端虽有
105 张 SQL 表、当前 100 个 Resource Catalog 资源和大量跨域事务，但边界已经相对清楚：ResourceBinding
承接通用资源面，编号/审计/总账/库存承接事实引擎，各业务域按 transaction closure 迁移。没有发现
必须依赖 PostgreSQL 特有查询、数据库锁或存储过程而无法在 Convex 重建的硬阻塞。

“整个后端迁到 Convex”在本方案中的准确边界是：业务数据、授权、查询、事务、定时任务和状态均以
Convex 为唯一权威；S3 专门保存 bytes；TanStack Start 只保留同源认证接线和有系统进程依赖的 PDF
转换。后二者不是第二套业务后端。最终删除 `server/`、REST/Kysely/SQL migrations 后，日常业务维护
不会双改。

需要实测而不能靠假设跨过的四个闸门是：Better Auth component 的真实 self-host 兼容、合法聚合在
单 mutation limits 内的原子性、第三方 S3 的签名/checksum 兼容、TanStack production container 的
LibreOffice 稳定性。计划把它们分别前置到 002、004/005、006、007；失败会在投入全量翻译前暴露，
目前均有不改变目标架构的实施路径。

## 已固定的目标架构

```text
浏览器
  ├─ TanStack Start：SSR、Better Auth 同源代理、首期 PDF 转换 worker
  ├─ Convex：查询、mutation、action、HTTP action、定时任务、业务数据
  └─ S3 兼容对象存储：浏览器经短时签名 URL 直传/下载产品文件

自托管 Convex
  ├─ Convex backend + dashboard（同版本固定镜像）
  ├─ PostgreSQL 17（Convex 持久化）
  └─ S3 兼容存储（Convex 自身 5 个 bucket）

本地：Compose 同时启动 PostgreSQL、MinIO、Convex backend/dashboard。
生产：第三方 S3 兼容服务；Convex 基础设施 bucket 与产品附件 bucket 分离。
```

以下决策不再留给执行者重新选择：

- 使用开源、自托管 Convex，不接商业版 Convex Cloud。
- 生产 Convex 持久化使用 PostgreSQL 17；不以 SQLite 承载生产。
- 本地开发必须随 Compose 启动 MinIO，并自动创建 5 个 Convex bucket 和 1 个
  `synie-product-files` 产品文件 bucket。
- 产品文件字节始终放第三方 S3 兼容存储；Convex 只保存元数据、授权与任务状态。
- 首期 XLSX→PDF 转换运行在 TanStack Start 的服务端容器；以后 Rust worker 只替换稳定的
  worker HTTP 契约，不改 Convex 业务 API、打印模板或前端调用。
- 不做 PostgreSQL 与 Convex 双写，不建设生产数据同步链路。当前系统未上线且无生产数据，
  最终切换采用重置后初始化。
- Resource Catalog 继续是声明事实源，但绝不成为通用写入引擎；聚合草稿和领域命令仍由
  各业务域的 mutation 实现。

## 执行顺序与状态

| Plan | 标题 | Priority | Effort | Depends on | Status |
|------|------|----------|--------|------------|--------|
| 001 | [建立可恢复的自托管 Convex 与本地 MinIO 基线](001-bootstrap-self-hosted-convex.md) | P1 | L | — | DONE |
| 002 | [建立 Better Auth、Actor 与 Convex 应用内核](002-establish-auth-and-application-kernel.md) | P1 | L | 001 | DONE |
| 003 | [以 ResourceBinding 竖切资源读写面](003-cut-over-resource-plane.md) | P1 | L | 002 | DONE |
| 004 | [移植编号、审计、总账、库存与受控投影](004-port-ledger-inventory-and-projections.md) | P1 | L | 003 | DONE |
| 005 | [按事务闭包迁移全部业务域](005-migrate-business-domains.md) | P1 | L | 004 | DONE |
| 006 | [迁移 S3 文件、导入、OCR、定时任务与外部 I/O](006-move-files-imports-and-jobs.md) | P1 | L | 003 | DONE |
| 007 | [在 TanStack Start 落地可替换的 PDF worker](007-run-pdf-worker-in-tanstack-start.md) | P2 | L | 005, 006 | DONE |
| 008 | [完成切流并删除 Bun/Hono/Kysely 后端](008-complete-cutover-and-remove-legacy-server.md) | P1 | L | 005, 006, 007 | TODO |

状态值：`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED（原因）` |
`REJECTED（原因）`。

## 依赖说明

- 002 必须在 001 后执行：身份组件要在真实自托管部署上验证，不能只在 Convex Cloud 或
  mock 上假定兼容。
- 003 先证明 Catalog、查询 profile、游标分页和前端 ResourceBinding seam，后续业务域
  才能按同一种形状迁移。
- 004 先建立事实引擎和 projection 原语；销售、采购、制造、财务等业务 mutation 都依赖它。
- 006 在 003 后即可开始；004 完成后启动 005，此时 005 与尚在推进的 006 可并行。005 的单据若
  依赖附件/OCR，只在 006 完成后做最终 E2E。
- 007 依赖业务 DocBuilder 与产品 S3；Rust 服务不属于首期范围。
- 008 是唯一允许删除 `server/`、SQL 迁移和 REST transport 的计划。

## 全程适用的迁移纪律

1. 一个资源在任一运行模式下只能有一个写入权威；禁止 REST 与 Convex 双写。
2. 迁移期保留两个**进程级**开发模式：`legacy` 用当前完整产品，`convex` 只暴露已经迁移并
   验收的闭包。禁止在一次业务事务中跨两个后端。
3. 旧后端代码与测试只作为行为 oracle；不要逐行翻译 SQL/Kysely 形状。
4. Convex mutation 内不得执行网络、文件系统、时钟随机副作用；外部 I/O 放 action，落库
   再回到 internal mutation。
5. 所有列表查询必须命中声明的 index/search index 和 query profile；不得用 `.filter()`
   扫表模拟现有任意 SQL DSL。
6. 所有金额/数量继续在 wire 上使用十进制字符串；存储采用经过范围证明的定标 `int64`，
   禁止改成浮点。
7. 每个阶段同时更新相应 ADR；只有用户可感知行为或业务规则变化时才更新
   `docs/产品文档/` 和 `CONTEXT.md`。

## 已考虑但否决

- **生产继续使用 SQLite**：自托管官方只把 SQLite 作为默认起步形态；本项目是多公司财务
  ERP，直接使用 PostgreSQL 17，避免上线后再迁持久层。
- **产品附件使用 Convex 原生 file storage**：当前单文件上限 50MB、附件需逐宿主鉴权，且
  用户已经指定第三方 S3；产品字节单独存 S3，避免 20MiB HTTP action 响应限制和 bearer
  URL 权限语义。
- **保留动态 `sysStorages` 管理界面**：目标只有一个配置化 S3 provider，本地和生产只换
  endpoint/credential；继续维护 local/S3/OSS 三套动态实现会增加维护面。该资源在迁移矩阵
  中标记为 `retired`，并同步更新系统管理产品文档。
- **在 Convex mutation 中同步转换 PDF**：LibreOffice 依赖进程、临时目录与字体，不适合
  Convex deterministic runtime。首期放 TanStack Start，后续通过同一协议替换 Rust。
- **一次性机械迁移全部 Resource Catalog 资源**：现有 ADR 已明确否决；按事务闭包逐波次
  迁移，并用机器可校验矩阵确保最终不漏资源或表。
