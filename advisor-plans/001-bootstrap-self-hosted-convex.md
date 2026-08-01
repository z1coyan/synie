# Plan 001: 建立可恢复的自托管 Convex 与本地 MinIO 基线

> **执行者说明**：严格按步骤执行，每一步都运行验证命令并确认预期结果。遇到 STOP 条件
> 立即停止并报告，不得临场改用 Convex Cloud、SQLite 生产库或另一种对象存储架构。完成后
> 更新 `advisor-plans/README.md` 中本计划的状态。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- compose.yaml .env.example package.json scripts/dev.ts README.md .github/workflows/ci.yml infra/convex docs/runbooks docs/adr`
> 若范围内文件有变化，先把下列“当前状态”摘录与实时代码逐项比对；不一致属于 STOP 条件。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

自托管 Convex 把商业版替你承担的数据库、对象存储、升级、备份和可观测性重新交回项目。
这一步要先把这些责任压缩成一个可重复启动、可恢复、版本固定的基线，后面的业务迁移才不
会建立在“开发机能跑但生产无法恢复”的假设上。用户已经确定生产使用第三方 S3 兼容服务、
本地使用 MinIO；两者必须通过同一组环境变量和 bucket 布局工作。

## 当前状态

- `compose.yaml:1-21` 只有当前产品 PostgreSQL，供 Bun/Hono/Kysely 使用：

  ```yaml
  name: synie
  services:
    postgres:
      image: postgres:17-alpine
      environment:
        POSTGRES_DB: synie
      ports:
        - "5441:5432"
  ```

- `scripts/dev.ts:3-13,67-88` 的一键开发只启动 PostgreSQL、跑 SQL migration，再启动
  `server + web`；没有 Convex、MinIO 或 bucket bootstrap。
- `.env.example:1-3` 目前只列 HeroUI token，没有任何后端或对象存储配置。
- `.scratch/ts-backend-rewrite/spec.md:9` 明确写明：

  > 系统未上线，无生产数据，无双活/兼容义务；开发库可随时 reset。

  因而本计划不建设旧 PostgreSQL 业务库到 Convex 的生产同步或双写。
- 官方自托管 README 明确要求部署 backend、dashboard、frontend 三部分；默认 SQLite，生产
  可接外部 SQL 数据库：
  <https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md>
- 官方数据库说明已测试 PostgreSQL 17，并强调 backend 与数据库同区低延迟；默认实例名
  对应数据库 `convex_self_hosted`：
  <https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/postgres_or_mysql.md>
- 官方 S3 配置固定需要五个 bucket：

  ```text
  S3_STORAGE_EXPORTS_BUCKET=convex-snapshot-exports
  S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET=convex-snapshot-imports
  S3_STORAGE_MODULES_BUCKET=convex-modules
  S3_STORAGE_FILES_BUCKET=convex-user-files
  S3_STORAGE_SEARCH_BUCKET=convex-search-indexes
  ```

  非 AWS provider 通过 `S3_ENDPOINT_URL` 接入：
  <https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md>
- 官方 Compose 暴露 backend `3210`、HTTP actions `3211`、dashboard `6791`，健康检查为
  `GET /version`；backend 与 dashboard 示例默认使用 `latest`，本项目必须改为同一固定版本：
  <https://raw.githubusercontent.com/get-convex/convex-backend/main/self-hosted/docker/docker-compose.yml>
- 官方升级说明要求升级前 export；export/import 路径需要停止外部流量，恢复环境变量后再
  放流：
  <https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/upgrading.md>
- 自托管不会自动把函数日志中的 PII 对客户端脱敏；需显式
  `REDACT_LOGS_TO_CLIENT=true`，可用 `DISABLE_BEACON=true` 关闭匿名 beacon：
  <https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/disabling_logging.md>

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| Compose 静态校验 | `docker compose config --quiet` | exit 0，无输出 |
| 启动基础设施 | `docker compose up -d convex-postgres minio minio-init convex-backend convex-dashboard` | exit 0；服务 healthy/completed |
| Convex 健康 | `curl -fsS http://127.0.0.1:3210/version` | exit 0，返回版本文本/JSON |
| Dashboard | `curl -fsSI http://127.0.0.1:6791` | 2xx/3xx |
| MinIO 健康 | `curl -fsS http://127.0.0.1:9000/minio/health/live` | exit 0 |
| 根类型检查 | `bun run typecheck` | exit 0 |
| 既有测试 | `bun run test` | 全部通过 |

上述 Bun 命令来自根 `package.json`；依赖一律只在仓库根使用 `bun install`。不要在子目录
创建第二份 lockfile。

## 范围

**范围内（仅允许修改这些路径）：**

- `compose.yaml`
- `.env.example`
- `.gitignore`（仅补本地 Convex secret/env 忽略项）
- `package.json`
- `scripts/dev.ts`
- `infra/convex/**`（新建：bucket 初始化、健康/备份/恢复 smoke、生产 env 模板）
- `docs/runbooks/convex-self-hosted.md`（新建）
- `docs/adr/2026-07-31-self-hosted-convex-platform.md`（新建）
- `.github/workflows/ci.yml`
- `README.md`
- `advisor-plans/README.md`（只更新状态）

**范围外（不要触碰）：**

- `server/src/**`、`server/db/**`：本计划必须保留当前后端可运行。
- `web/app/**`、`convex/**`：应用函数与前端接线由后续计划完成。
- 生产云厂商专属 Terraform/Kubernetes；当前只定义 provider-neutral 容器与运行手册。
- 产品文件协议和 `sysStorages` 清场；Plan 006 负责。
- 删除任何现有 Docker volume。既有开发数据可能属于操作者。

## Git 工作流

- 分支：`advisor/001-self-hosted-convex`
- 按“Compose/MinIO”“开发脚本”“运维文档与 CI”三个逻辑单元提交。
- 仓库提交风格为 conventional commits，例如 `refactor: 深化前端资源与聚合架构`；本计划可用
  `feat(infra): 建立自托管 Convex 开发基线`。
- 未经操作者要求，不 push、不开 PR、不删除 volume。

## 步骤

### Step 1: 固定镜像、网络端口与持久化拓扑

在 `compose.yaml` 保留现有 `postgres/migrate/server/seed`，新增以下迁移期服务：

- `convex-postgres`：`postgres:17-alpine`，独立 volume，数据库
  `convex_self_hosted`，仅供 Convex；不要复用旧 `synie` 业务数据库。
- `minio`：固定 MinIO release tag，暴露 API `9000`、console `9001`，独立 volume。
- `minio-init`：等待 MinIO healthy，幂等创建六个 private bucket：官方五个 bucket 加
  `synie-product-files`。重复执行必须 exit 0。
- `convex-backend`：backend 镜像使用 `${CONVEX_VERSION:?}` 精确 tag；设置
  `POSTGRES_URL`（不含数据库名）、`INSTANCE_NAME=convex-self-hosted`、五个官方 bucket、
  `S3_ENDPOINT_URL=http://minio:9000`、`AWS_S3_FORCE_PATH_STYLE=true`、
  `REDACT_LOGS_TO_CLIENT=true`、`DISABLE_BEACON=true`。保留默认并发 16，未压测前不调大。
- `convex-dashboard`：使用与 backend 完全相同的 `${CONVEX_VERSION}`，依赖 backend healthy。

为上述服务设置明确 healthcheck、restart policy 和 stop grace period。Local credentials 可以在
`.env.example` 给出仅开发可用默认值；生产模板必须留空且注释“由 secret manager 注入”。

**Verify**：`docker compose config --quiet` → exit 0；展开后的 backend/dashboard image tag
完全相同且不含 `latest`。

### Step 2: 自动初始化本地 MinIO 与跨 provider 配置

在 `infra/convex/` 创建幂等 bucket 初始化脚本及 CORS 配置：

- 六个 bucket 均为 private，禁止 anonymous read/write。
- 只有 `synie-product-files` 允许来自 `http://localhost:3000` 的带签名 `PUT/GET/HEAD`；
  生产 origin 由环境变量生成，不硬编码在镜像。
- Convex 的五个内部 bucket 不配置浏览器 CORS。
- 分开定义 `SYNIE_S3_INTERNAL_ENDPOINT` 与 `SYNIE_S3_PUBLIC_ENDPOINT`。本地分别是容器可达的
  `http://minio:9000` 和浏览器可达的 `http://localhost:9000`；不要把内部主机名签进浏览器 URL。
- 生产两个 endpoint 可以相同，但仍保留两个变量，避免以后私网 endpoint 改动业务代码。

在 `infra/convex/production.env.example` 列全第三方 provider 必需配置与兼容性要求：path-style、
SigV4、CORS、presigned PUT/GET/HEAD、checksum/metadata HEAD、bucket lifecycle。不得提交 access key。

**Verify**：启动 MinIO 与 init 后，运行 `docker compose run --rm minio-init verify` → 输出六个
且仅六个预期 bucket，全部 private；第二次运行同命令仍 exit 0。

### Step 3: 把基础设施接入一键开发，但保留 legacy 默认模式

修改 `scripts/dev.ts` 和根 scripts：

- 默认 `bun run dev` 先启动 `postgres`（旧后端暂用）、`convex-postgres`、`minio`、
  `minio-init`、`convex-backend`、`convex-dashboard`。
- 分别等待 PostgreSQL、MinIO、Convex `/version`，错误信息给出对应 `docker compose logs` 命令。
- `--no-docker` 表示操作者已经提供所有外部依赖，不能只跳过 PostgreSQL 却仍隐式依赖 MinIO。
- 提供 `dev:infra`、`infra:health`、`infra:down`；`infra:down` 只能 stop/down，不带 `-v`。
- 第一次生成 self-hosted admin key 时只写入 gitignored `.env.local`，终端不得打印完整 key；若
  自动化无法可靠解析官方脚本输出，则保留一次性 `bun run convex:bootstrap` 并在启动时给出
  明确命令，不要把 key 写进 `.env.example`。
- 迁移期仍启动 legacy server + web；Convex code watcher 要到 Plan 002 创建 `convex/` 后再加入。

**Verify**：在干净的临时 Compose project name 下执行 `bun run dev:infra`，随后
`bun run infra:health` → PostgreSQL、MinIO、backend、dashboard 全部报告 healthy。Ctrl+C 后
volume 仍存在。

### Step 4: 编写备份、恢复和升级 runbook

`docs/runbooks/convex-self-hosted.md` 必须明确：

1. 生产 backend 与 PostgreSQL 同 region；外部只经 TLS reverse proxy 暴露 3210/3211，dashboard
   不直接公开。
2. 初期目标 RPO ≤ 24h、RTO ≤ 4h；若产品负责人调整，只改 runbook 中一处参数表。
3. 每日 portable snapshot 使用 `npx convex export --path ...`，存入 exports bucket；同时由第三方
   provider 备份 PostgreSQL 和六个 S3 bucket。
4. Convex export 只覆盖表/文件数据；Git 中的函数代码、部署环境变量、未执行 scheduled
   functions 必须分别保存/重建。环境变量只保存名称清单和 secret-manager 引用，不把值写入仓库。
5. 恢复演练使用全新 Compose project/volume，执行 `npx convex import --replace-all`，部署同一
   Git SHA 函数并恢复 env，然后跑应用 smoke。不得覆盖开发者当前 volume。
6. 升级前固定 backend/dashboard 同版本、停止外部写流量、export、升级、等待 migration complete
   日志、跑 smoke；失败走 export/import 恢复。禁止直接把 tag 改成 `latest`。
7. 记录磁盘、PostgreSQL 连接、S3 错误、action/mutation 队列、函数错误率和 `/version` 的告警项。

在 `infra/convex/` 提供只接受显式输出目录/目标 project name 的脚本；拒绝 `/`、`~` 或空路径。

**Verify**：在临时栈创建一条 smoke 数据，执行备份→新栈恢复→查询对拍；脚本输出记录源/目标
deployment、snapshot checksum、耗时，且测试后只停止临时栈，不删除原栈数据。

### Step 5: 加入 CI 基础设施 smoke 与文档

在 `.github/workflows/ci.yml` 增加独立 `convex-infra` job：

- 使用固定镜像 tag；启动 Postgres、MinIO、Convex backend/dashboard。
- 校验六个 bucket、`/version`、dashboard 响应、backend 日志含 PostgreSQL 连接成功。
- 不需要 HeroUI token，不运行尚未创建的业务函数。
- 失败时上传经过脱敏的 compose logs；不得输出 access/admin secret。

更新 `README.md` 的环境要求、端口表和本地命令，明确 9000/9001/3210/3211/6791 用途，以及
生产用第三方 S3、本地用 MinIO。

**Verify**：CI workflow YAML 可解析；本地运行同一 smoke 脚本 exit 0；`rg -n "latest" compose.yaml infra/convex .github/workflows/ci.yml` 不得命中 Convex/MinIO image。

## 测试计划

- Compose config：缺 `CONVEX_VERSION` 时 fail-fast；backend/dashboard 版本不一致时 verify 脚本失败。
- MinIO init：首次建 bucket、重复执行、CORS、private policy、错误 credential 四类。
- 健康：PostgreSQL 未就绪时 backend 不抢跑；MinIO 不可用时健康脚本明确指出服务。
- 恢复：portable export/import 到全新 volume 后数据和文件 checksum 对拍。
- 日志：模拟函数错误，客户端看不到内部日志/PII；backend 环境确有
  `REDACT_LOGS_TO_CLIENT=true`。
- 现有回归：`bun run test && bun run typecheck` 全绿。

## 完成条件

- [ ] `docker compose config --quiet` exit 0，所有基础镜像固定版本。
- [ ] `bun run dev:infra` 一次启动本地 PostgreSQL、MinIO、Convex backend/dashboard。
- [ ] 六个 bucket 自动存在且 private；产品 bucket CORS 可供 localhost 签名请求。
- [ ] Convex 使用 PostgreSQL 17 和 MinIO，而不是容器内 SQLite/文件系统。
- [ ] backend/dashboard `/version` 与镜像版本一致，客户端日志已脱敏。
- [ ] 全新临时栈完成一次真实 export/import 恢复演练，满足 RTO 目标。
- [ ] `bun run test`、`bun run typecheck` 通过。
- [ ] 无 secret 被 Git 跟踪：`git diff --check` 通过，secret scan 无命中。
- [ ] 除范围内文件外无修改；`advisor-plans/README.md` 状态已更新。

## STOP 条件

出现以下任一情况立即停止并报告：

- 选定的 self-hosted Convex release 没有 backend/dashboard 同版本镜像。
- 第三方 S3 provider 不支持 SigV4、private bucket 或 presigned 请求；不要为某厂商手写第二套协议。
- Convex backend 无法同时通过 PostgreSQL 17 与 MinIO 启动，或实际退回 SQLite/本地文件存储。
- 恢复后的表/文件 checksum 不一致。
- 必须删除、重建或改名现有 Docker volume 才能继续。
- 需要把 admin key、S3 secret 或生产 URL 提交进仓库。
- 范围内代码已经漂移且与“当前状态”摘录不符。

## 维护说明

- 同一时间只升级一组 backend/dashboard 固定版本；每次升级都重跑恢复演练。
- 初期不要盲目提高 `APPLICATION_MAX_CONCURRENT_*`。压测确认 CPU、PostgreSQL 与 mutation 冲突
  后再改，并把依据写进 runbook。
- Convex 的五个内部 bucket 与 `synie-product-files` 即使在同一 provider/account，也必须分 bucket；
  生命周期、CORS 和访问主体不同。
- 本地 MinIO 是开发替身，不是生产部署建议。业务代码只能依赖 S3 契约和环境配置。
