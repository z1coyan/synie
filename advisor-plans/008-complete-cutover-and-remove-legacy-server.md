# Plan 008: 完成切流并删除 Bun/Hono/Kysely 后端

> **执行者说明**：这是唯一允许删除 `server/`、SQL migrations 和 REST transport 的阶段。必须先让
> 005/006/007 的机器可校验 readiness report 全绿，并确认“系统尚未上线、无生产业务数据”仍成立。
> 删除前创建可恢复的 Git tag；不要删除 Docker volume、S3 object 或外部备份。遇到 STOP 条件立即报告。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- package.json bun.lock turbo.json scripts/dev.ts compose.yaml .github/workflows/ci.yml server web README.md AGENTS.md CONTEXT.md docs/产品文档 docs/adr docs/migration`
> 本计划本来就依赖前七阶段产生大范围变化；先把变化与各阶段 DONE evidence 对拍，任一未解释漂移即 STOP。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/005-migrate-business-domains.md`,
  `advisor-plans/006-move-files-imports-and-jobs.md`,
  `advisor-plans/007-run-pdf-worker-in-tanstack-start.md`
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

迁移的维护收益只有在旧后端真正退出工作树后才兑现。长期保留 Hono/Kysely、SQL schema、REST clients、
两套 auth 和两套 Compose/CI 会让每次业务修改仍需判断哪个实现是权威。本计划在 Convex 业务闭包、S3
I/O 和 TanStack PDF Worker 全部验收后，完成一次无数据搬运的干净切换：运行系统只剩 TanStack Start、
自托管 Convex、Convex PostgreSQL 和 S3 compatible storage。

## 当前状态

- 根 `package.json:6-22` 把 `server` 列为 workspace，`dev/test/typecheck/db:*` 都显式调用
  `@synie/server`；这会在删除目录后直接失效。
- `web/package.json:54-56` 依赖 `@synie/server` 和 `hono`，用 `ApiType`/`hono/client` 形成现有 REST
  wire contract；Plan 003/005 必须先把全部 bindings/commands 换成 Convex。
- `web/vite.config.ts:13-20` 代理 `/api/v1` 到 `SYNIE_API_PORT`；目标只保留同源 Better Auth
  `/api/auth/*` 与 TanStack internal print-worker route，不再有业务 REST proxy。
- `compose.yaml:1-52` 当前启动业务 PostgreSQL、migrate、Bun server 和 seed；Plan 001 的最终 Compose
  则应启动 Convex PostgreSQL、MinIO/init、Convex backend/dashboard 和可选 Web Worker。
- `scripts/dev.ts:1-100` 当前创建 `server/.env`、启动业务 PG、执行 Kysely migration，再启动 server+web；
  最终开发入口应只确保 Plan 001 infra/MinIO/Convex healthy，并并行运行 Convex function watcher 与 Web。
- `.github/workflows/ci.yml:1-54` 的 server job 依赖 PostgreSQL service、Kysely migrate/codegen 和
  `server` tests；最终应改成 shared/Convex codegen+tests、自托管 integration 与 Web checks/build。
- `README.md:5-15,64-155`、`web/AGENTS.md:3-28`、`CONTEXT.md:108,121` 仍把 Hono REST、JWT、
  `/api/v1`、业务 PostgreSQL 或文件流写成当前事实。
- 现有清场先例 `docs/migration/2026-07-28-go-to-bun-ts-cutover.md:13-39` 使用删除前 tag、CI/Compose/
  文档收敛和新克隆验收；Git 已有 `server-go-final` 与 `backend-elixir-final`，本次沿用
  `server-bun-final`。
- 当前已知前提：项目未上线、没有需要迁移的生产业务数据；因此不写 SQL→Convex importer，不双写。

## 最终拓扑

```text
TanStack Start server container
  ├─ Web/SSR
  ├─ Better Auth 同源 routes
  └─ internal PDF Worker
        │
        ├────────> self-hosted Convex backend/dashboard
        │                  └─ PostgreSQL 17（仅 Convex 持久化）
        └────────> S3 compatible storage
                           ├─ Convex 5 buckets
                           └─ synie-product-files
```

仓库中不再存在 `server/`、Kysely、Hono business API、业务 SQL migrations、JWT localStorage 或
`/api/v1`。TanStack server routes 不是通用业务后端；只承载 Better Auth proxy/handler 和内部 PDF Worker。

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| Readiness | `bun run check:convex-cutover-readiness` | 0 legacy/table gap/REST binding |
| Fresh install | `bun install --frozen-lockfile` | workspace/lockfile 一致，exit 0 |
| Static gates | `bun run check && bun run typecheck && bun run test && bun run build` | 全部 exit 0 |
| Self-host E2E | `bun run e2e:self-hosted` | setup + ERP + S3 + PDF 全链绿 |
| Restore drill | `bun run test:self-hosted-restore` | Convex + 六个 bucket 对拍通过 |
| Legacy scan | `bun run check:no-legacy-server` | 活动源码/配置 0 命中 |
| Compose | `docker compose config && docker compose up -d --build` | 全部 health，MinIO buckets 已建 |

## 范围

**范围内：**

- 删除整个 `server/`（源码、tests、Dockerfile、SQL migrations、Kysely codegen、server env example）
- 根 `package.json` workspaces/scripts、`bun.lock`、`turbo.json`、`scripts/dev.ts`
- `compose.yaml` 与 `infra/convex/**` 的最终单栈开发/生产示例
- `.github/workflows/ci.yml` 和测试/构建/镜像/secret scan gates
- `web/package.json`、`web/vite.config.ts`、所有 legacy REST/auth/client adapters 与 tests
- `web/AGENTS.md`、根 `AGENTS.md`（只有当前架构/命令叙述需要变更时）
- `README.md`、`CONTEXT.md`、受影响的 `docs/产品文档/**`、架构 ADR
- `docs/migration/2026-07-31-bun-server-to-self-hosted-convex-cutover.md`（新建完成记录）
- `.scratch/convex-backend-migration/**` 的最终 evidence/issue 状态（若前期计划已建立）
- 本地 annotated tag `server-bun-final`
- `advisor-plans/README.md` 状态

**范围外：**

- SQL→Convex 生产数据 importer、CDC、双写、停机数据搬迁。
- 删除历史 Git tags/commits、`docs/migration` 历史归档或迁移前行为 fixtures。
- 删除 Docker volumes、MinIO objects、备份目录或第三方 S3 buckets。
- Rust PDF Worker、动态多 S3 provider、Convex Cloud、SQLite production。
- 趁清场改变业务规则、重做 UI、提高打印/文件/导入限制。
- 把 TanStack Start 扩张成新的 CRUD/领域 REST 后端。

## Git 工作流

- 分支：`advisor/008-convex-final-cutover`
- **先**完成 readiness 与全链验证并提交，**再**执行
  `git tag -a server-bun-final -m "Bun/Hono server before self-hosted Convex cutover" HEAD`。
- tag 已存在时先 `git show server-bun-final`；若不指向这次删除前提交，STOP，禁止 force/覆盖。
- 删除与 workspace/CI/Compose/文档收敛分逻辑提交；建议最终提交：
  `chore: 完成自托管 Convex 后端切换`。
- 不 push tag/branch、不开 PR，除非用户另行要求。

## 步骤

### Step 1: 冻结并机器验证最终 coverage

汇总 Plan 003/005/006/007 manifests 为一个 committed JSON report，检查：

- 97 个 Resource Catalog 基线资源全部为 `convex-verified` 或有批准理由的 `retired`；
- 105 张 SQL 表全部映射为 Convex source/fact/projection/merged/retired，无 unexplained；
- 279 个非测试生产源码 `withTx` 调用点全部映射为单个 Convex transaction closure/test 或批准淘汰；
- 53 个 declared commands、六个 Aggregate Draft、setup/sample、files/imports/OCR/jobs/printing 全有 target；
- Web active bindings、commands、auth、setup、files、printing 对 business `/api/v1` 的引用为 0；
- legacy/convex 进程模式中 convex 已全量，且不存在一次业务动作跨后端。

`check:convex-cutover-readiness` 从 committed manifest 计算分母，不能靠人工勾选；报告附每项 target path、
test 和文档链接。固定报告 hash 供删除后对拍。

**Verify**：命令 exit 0，并精确输出 `legacyResources=0`、`unmappedTables=0`、`restBindings=0`、
`unmappedTransactions=0`、`crossBackendClosures=0`；任一非零不得进入 Step 2。

### Step 2: 在 fresh self-hosted stack 做发布候选验收

从空 volumes/buckets 的**隔离临时环境**（不是删除现有 volume）执行：

1. 启动固定版本 Convex PostgreSQL、MinIO/init、Convex backend/dashboard、TanStack Web/Worker；
2. 部署 Convex functions/auth component/schema/indexes，检查 codegen 无 diff；
3. setup 首管理员、空白 seed与 sample seed 幂等；
4. 跑跨域 ERP E2E、权限/公司反向用例、GL/库存 projection 对拍；
5. 跑 50MB S3、银行/考勤导入、OCR fixture、cron lease、打印/导出及 Worker down 降级；
6. 分别重启 Convex/Web/PostgreSQL/MinIO，确认恢复、subscription 和任务 lease；
7. 做 Convex snapshot/export + 六 bucket backup，再恢复到第二套空环境并全量 checksum/reconciliation。

本步骤不读取旧业务 PostgreSQL，也不以 legacy server 兜底。记录镜像 digest、schema/function revision、
测试结果、RPO/RTO 和 restore evidence，secret/endpoint 脱敏。

**Verify**：所有 checks 绿；浏览器网络只有 Convex、S3 signed URL、同源 auth，不出现业务 `/api/v1`；
恢复后 setup/ERP/file/print smoke 与源环境一致。

### Step 3: 再确认无生产数据前提并定义回滚点

在删除前的 cutover checklist 记录负责人确认：

- 当前没有生产用户、法定账务、正式附件或必须保留的业务 PostgreSQL 数据；
- 不需要 SQL importer/CDC/双写；初始化 Convex 是允许的产品行为；
- production S3 candidate 已通过 Plan 006 compatibility，备份凭据与恢复责任明确；
- previous release artifact、Git commit/tag、Convex snapshot、S3 backup 可定位。

把 rollback 分成两层：

- 删除合并/发布前：切进程级 `legacy` 模式或回退 commit。
- 删除发布后：重新部署 `server-bun-final` 对应完整旧 release；不要在新代码树临时复活半套 `server/`。

由于不迁移生产数据，回滚不做新旧数据库合并。若此时发现任何必须保留的真实数据，**停止本计划**，
另写数据迁移 ADR/演练，不临时补脚本。

**Verify**：checklist 与恢复坐标进入 migration record；在隔离环境实际从 tag 构建旧 server，证明 tag
可恢复，但不连接/覆盖当前 Convex 或 S3 数据。

### Step 4: 创建删除前 tag，然后移除 legacy server

确保 worktree clean、readiness evidence 已提交后创建 annotated `server-bun-final`。随后删除：

- `server/` 全目录；
- root workspace 中 `server`；`@synie/server` 的 dev/test/typecheck/db:migrate/db:seed/db:reset scripts；
- `web` 的 `@synie/server`、`hono` 依赖与 `hono/client`/ApiType adapters；
- `/api/v1` Vite proxy、`SYNIE_API_PORT`/`GO_API_PORT`、`DATABASE_URL`/`AUTH_SECRET`/JWT TTL 的活动配置；
- legacy `synie:token` localStorage、login/me/setup/files/printing REST transport 和 process-mode switch；
- Kysely/SQL codegen/migration fixtures、server Docker build contexts 和 only-legacy test helpers。

只删除已由 readiness report 指向 replacement tests 的文件。历史 migration docs 可提及旧路径；不要为了
让 `rg` 归零而篡改历史记录。`packages/shared` 继续作为前后端纯 wire/domain primitives workspace。

**Verify**：`test ! -d server`；`bun install --frozen-lockfile` 成功；lockfile 不再解析
`@synie/server|hono|kysely`（除其他明确依赖的非 server 用途，若存在需逐项解释）。

### Step 5: 收敛根开发入口与 Compose，保留本地 MinIO

将 `scripts/dev.ts`/root scripts 改为一个维护路径：

- 默认 `docker compose up -d` 启动 Plan 001 的 `convex-postgres`、`minio`、`minio-init`、
  `convex-backend`、`convex-dashboard`；等待 PostgreSQL/MinIO buckets/Convex health。
- 开发前确认本地 deployment/admin key/env 已 bootstrap；并行启动 self-host Convex function watcher 与
  `synie-web`，日志打印 Web/dashboard/Convex/MinIO console 的真实地址。
- `--no-docker` 只允许用户提供完整 external self-hosted Convex URL/admin key 与 S3 endpoint；不再接
  任意业务 `DATABASE_URL`。
- 保留 `dev:web`、`dev:convex`、`infra:up/down/logs/bootstrap/backup/restore` 等明确 scripts；删除 db:*。
- `docker compose down` 默认不带 `-v`；停止服务不删除 Convex PostgreSQL/MinIO volumes。

Compose 最终只含目标拓扑，不留 `migrate/server/seed` legacy services。MinIO/init 始终在本地默认
profile，自动创建五个 Convex bucket + `synie-product-files`，不是可选工具 profile。

**Verify**：fresh clone 按 README 单条开发命令能启动并完成 setup；第二次启动幂等且保留数据；
`docker compose down && up` 后数据仍在；只有显式、带警告的 reset 工具才可清空开发 volumes。

### Step 6: 重写 CI 为目标栈门禁

把 `.github/workflows/ci.yml` 收敛为：

- install：固定 Bun、`bun install --frozen-lockfile`、secret scan；
- shared/Convex：format/lint/typecheck/unit、generated API/schema/index/manifest freshness；
- self-host integration：以固定镜像启动 PostgreSQL+MinIO+Convex，创建 buckets、部署 functions，跑
  auth/setup/transaction/projection/S3/import/job tests；
- Web：check/unit/build/typecheck，production server artifact smoke；
- PDF：构建 `web/Dockerfile`，fake tests 必跑；真实 LibreOffice/字体 golden 至少在 Linux CI 跑 smoke；
- Playwright：全 convex mode E2E，网络断言业务 `/api/v1` 为零；
- backup/restore：可做 nightly/受控 job，但 PR 至少运行小型 snapshot+object restore smoke。

删除业务 PostgreSQL service、Kysely migrate/codegen 和 `working-directory: server`。CI 与本地使用同一
Compose/infra helpers，不能另造只在 CI 成立的云版 Convex 路径。

**Verify**：fresh CI 全绿；故意改 schema 不提交生成物、漏 binding、加入 REST client、删 MinIO bucket、
破坏 Worker health 各自会让对应 gate 红。

### Step 7: 收敛文档、术语和架构约束

更新：

- `README.md`：唯一当前栈、自托管启动/备份/升级、Web/Convex/dashboard/MinIO 地址、测试命令；
- `web/AGENTS.md`：Convex ResourceBinding、Better Auth、S3 `~/lib/files`、server-only PDF route，删除
  Hono/REST/JWT/Vite proxy 规则；
- `CONTEXT.md`：Setup API 和模板打印词条移除 `/api/v1`/Bun 文件流，保持业务定义不变；
- `docs/产品文档/系统管理.md` 及实际受影响篇：只改已变化的系统边界/用户等待提示，不改领域规则；
- ADR：把 self-host Convex、S3、auth、facts/projections、Worker、cutover 的最终决策互链；
- 新 migration record：tag/commit、删除清单、coverage、测试、fresh clone、backup/restore、回滚。

历史 `docs/migration/*` 保持原貌并明确是历史；根文档不再称 Bun/Hono 是当前产品后端。若根
`AGENTS.md` 没有技术栈叙述则不为制造 diff 而改。

**Verify**：产品文档链接检查全绿；活动文档的 `REST|Hono|Kysely|JWT|/api/v1|业务 PostgreSQL`
命中为 0 或逐项是历史链接；`CONTEXT.md` 术语仍唯一、没有同时存在旧/新两个当前定义。

### Step 8: 运行零残留扫描与最终验收

新增 `check:no-legacy-server`，默认扫描活动源码/配置，不扫描 `.git`、tag 或明确 historical fixtures：

```bash
rg -n '@synie/server|hono/client|\bhono\b|kysely|SYNIE_API_PORT|GO_API_PORT|synie:token|/api/v1|server/src' \
  package.json bun.lock turbo.json scripts compose.yaml .github web convex packages README.md AGENTS.md CONTEXT.md
```

同时检查：

- `rg -n 'DATABASE_URL|AUTH_SECRET|AUTH_TOKEN_TTL'` 的活动命中只允许第三方依赖明确需要；Convex
  PostgreSQL 使用专用、语义清楚的 env 名称，不复用 legacy business DB 变量。
- 浏览器 bundle 不含 Worker HMAC/S3 secret/admin key；server-only modules 未打入 client chunks。
- 0 REST fallback、0 legacy process mode、0 dynamic `sysStorages`、0 business SQL migration command。
- `git diff --check`、完整 CI、本地 self-host E2E/restore、production image smoke 全绿。

删除 material 后不要执行 `docker compose down -v`、`docker volume rm` 或 bucket cleanup。migration record
注明旧本地 volume 仍可恢复/人工清理；建议至少保留到一个约定观察期后再由用户单独决定。

**Verify**：所有命令 exit 0，`git status --short` 只含本计划预期改动；从 fresh clone 仅按新 README
完成启动、setup、样例、附件、导入、打印、备份恢复。

### Step 9: 发布、观察与关闭迁移开关

按 runbook 部署固定镜像/functions revision，完成 health/setup/smoke；观察 auth failure、Convex OCC/
limits、projection drift、S3 error/job backlog、PDF saturation。无生产数据不等于可以跳过恢复和重启演练。

验收后删除临时 `legacy|convex` mode flag 和只为迁移存在的 adapters/manifests generator；**保留**最终
coverage manifest/checker 作为架构测试。把所有 001–008 状态置 DONE，迁移 issue/spec 关闭，记录实际
commit/tag/image/function revision。

回滚只部署完整 prior release，不在线双写；恢复新 Convex/S3 snapshot 时必须成对恢复。观察期后旧
Docker volumes 的删除属于独立、用户明确授权的破坏性操作，不在本计划自动执行。

**Verify**：目标环境稳定完成一轮完整 ERP E2E + restart + scheduled jobs；迁移 flags/adapters 归零，
最终 coverage checker 留存并在 CI 运行。

## 测试计划

- Coverage：97 resources、105 tables、279 个 production `withTx` sites、53 commands、六 drafts 与
  I/O endpoints。
- Fresh stack：固定镜像、MinIO 六 buckets、自托管 auth/functions/setup/sample、重复启动。
- Domain：跨域 ERP、permission/company、number/audit、GL/inventory facts/projections。
- I/O：50MB files、5k/100k imports、OCR、cron/lease、print/export、Worker down。
- Recovery：Convex+S3 配对 backup/restore、四服务 restart、job/projection reconcile。
- Web：build/typecheck/check/unit/Playwright，network 0 `/api/v1`，bundle secret/server-only scan。
- Cleanup：workspace/lockfile/Compose/CI/docs/legacy identifiers 与 tag recovery。
- Fresh clone：只照最终 README，从安装到完整 smoke，无隐含本机状态。

## 完成条件

- [x] readiness 报告为 0 legacy/REST/gap/cross-backend，且覆盖分母机器生成。
- [x] “无生产数据、无需 importer/双写”前提被再次明确确认并记录。
- [x] `server-bun-final` 指向删除前可构建提交，旧完整 release 可在隔离环境恢复。
- [x] `server/`、Hono/Kysely、业务 SQL migrations、JWT localStorage、`/api/v1` 全部退出活动树。
- [x] 本地默认启动 Convex PostgreSQL + MinIO/init + backend/dashboard；六 buckets 幂等存在。
- [x] 生产/本地都是 Convex + S3 code path，TanStack 只保留 auth/Web/internal PDF Worker server 能力。
- [x] 新 CI、fresh clone、自托管 E2E、生产 Web image、backup/restore 全绿。
- [x] README/AGENTS/CONTEXT/产品文档/ADR/migration record 收敛且链接有效。
- [x] 未删除任何 volume/bucket/backup；迁移 flags 清除；最终 coverage gate 留在 CI；索引 DONE。

## STOP 条件

- readiness 任一数字非零，或只有人工声明没有可重跑证据。
- 发现生产/必须保留的数据、附件、法定账务或活跃用户，需要 SQL→Convex 搬迁或停机协调。
- 任一业务动作仍需 legacy REST、跨后端事务或 REST fallback 才能完成。
- self-hosted auth/setup、facts/projections、S3/import/jobs/PDF 任一没有在真实目标 stack 验证。
- Convex snapshot 与产品 S3 无法配对备份/恢复，或恢复后 checksum/projection 不一致。
- `server-bun-final` 已存在但指向其他提交，或 tag 对应旧 release 无法构建。
- 删除旧 tests 前找不到 replacement behavior tests/evidence。
- 目标平台要求改用 Convex Cloud、公开 bucket、静态 Web 或其他违背已定架构的前提。
- 用户要求顺便清空 volume/bucket/backup，但没有给出明确目标和独立确认。

## 维护说明

- 切换后新增业务只能进入 Convex domain mutation/query/action 与 ResourceBinding；TanStack server route
  不是新的业务逻辑落点。
- 每加 resource/table-like collection/command/aggregate 都更新 coverage manifest；CI 防止再次出现“旧实现
  还在但没人知道是否可删”的维护债。
- Convex PostgreSQL 与六个 S3 buckets 是一个恢复单元；升级 backend/dashboard 必须同版本、先备份并
  在 staging 演练，遵循 Plan 001 runbook。
- Git tag 用于考古，不是运行时 fallback。旧 volume/bucket 的实际删除在观察期后另开明确、可恢复性已
  确认的运维动作。
