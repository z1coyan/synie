# Synie

Synie 是面向中小企业的多公司财务 ERP，使用单一 TypeScript 工具链。当前运行架构只有：

- `web/`：TanStack Start + React 19，承载 SSR、Better Auth 同源路由与内部 PDF Worker。
- `convex/`：自托管 Convex 函数、schema、鉴权、领域事务、任务与定时调度，是唯一业务事实源。
- `packages/shared/`：前端与 Convex 共用的纯 TypeScript 领域原语。
- `infra/convex/`：PostgreSQL 17、MinIO、Convex backend/dashboard、健康检查、备份与恢复工具。

Resource Catalog 声明资源字段与查询 profile；业务写入仍由各领域 mutation 与 Aggregate Draft
事务闭包承载。产品文件字节位于私有 S3-compatible storage，Convex 保存元数据、权限和任务状态。

旧独立后端的完成记录、恢复坐标与删除证据见
[`docs/migration/2026-07-31-bun-server-to-self-hosted-convex-cutover.md`](docs/migration/2026-07-31-bun-server-to-self-hosted-convex-cutover.md)。

## 目录

```text
.
├── convex/                 # 业务函数、schema、auth、engines、jobs
├── web/                    # TanStack Start 与内部 PDF Worker
├── packages/shared/        # 共享领域原语
├── infra/convex/           # Compose 编排、S3、备份/恢复/烟测
├── docs/adr/               # 架构决策
├── docs/产品文档/          # 功能说明书
├── CONTEXT.md              # 领域术语唯一定义
└── compose.yaml            # 完整自托管目标栈
```

根 `package.json` 统一管理 `packages/*` 与 `web` workspaces；依赖安装始终在仓库根执行。

## 环境要求

- Bun `1.3.14`
- TypeScript `7.0.2`
- Docker Engine 与 Docker Compose v2
- 能拉取固定版本的 Convex backend/dashboard、PostgreSQL 17 与 MinIO 镜像
- Web 全新构建需 `HEROUI_AUTH_TOKEN`；本地无 token 时只可显式复用同 lockfile 下已合法构建的 licensed base 镜像

先创建本地配置。`CONVEX_VERSION` 必须是 backend 与 dashboard 共用的 40 位不可变 commit tag：

```bash
cp .env.example .env
bun install --frozen-lockfile
```

全新工作树可直接运行正式的本地复位入口，把当前工作树的 Compose project 建成可打开 `/setup` 的
空部署：

```bash
bun reset
```

命令会要求输入解析后的 Compose project 名确认；它不是 seed 命令，而是只面向本地开发的破坏性
重建。历史兼容入口 `bun db:reset` 与其行为完全相同。

本地默认端口均只绑定 `127.0.0.1`：

| 服务 | 默认地址 |
|---|---|
| Web / Better Auth / PDF Worker | `http://127.0.0.1:3000` |
| Convex backend | `http://127.0.0.1:3210` |
| Convex site / HTTP actions | `http://127.0.0.1:3211` |
| Convex dashboard | `http://127.0.0.1:6791` |
| 产品 S3 代理 / MinIO console | `http://127.0.0.1:9000` / `http://127.0.0.1:9001` |
| Convex PostgreSQL | `127.0.0.1:5442` |

需要从另一台 Tailscale 设备验证时，可在 `.env` 将浏览器访问面显式绑定到所有 IPv4 接口，并把
public URL 与产品文件 CORS origin 统一改为本机 Tailscale IPv4（下面的 `100.x.y.z`）：

```dotenv
SYNIE_BIND_HOST=0.0.0.0
CONVEX_CLOUD_ORIGIN=http://100.x.y.z:3210
SYNIE_CONVEX_PUBLIC_SITE_URL=http://100.x.y.z:3211
VITE_CONVEX_URL=http://100.x.y.z:3210
VITE_CONVEX_SITE_URL=http://100.x.y.z:3211
VITE_SITE_URL=http://100.x.y.z:3000
SYNIE_S3_PUBLIC_ENDPOINT=http://100.x.y.z:9000
SYNIE_PRODUCT_FILES_CORS_ORIGIN=http://100.x.y.z:3000
```

该开关只影响 Web、Convex backend/site 与产品 S3 代理；dashboard、PostgreSQL 和 MinIO console
仍固定绑定 `127.0.0.1`。`0.0.0.0` 同时监听非 Tailscale 网卡，主机防火墙必须只允许受信任来源；
此模式仅供短期内网开发验证，不得用于公网或共享开发服务器。纯 HTTP 的 Tailscale IP 也不是浏览器
secure context；依赖 Web Crypto 的附件校验/打印应继续从 localhost 验证，或另配受信任 HTTPS 入口。

## 本地开发

已有 setup-ready deployment 的日常开发用一条命令启动基础设施，必要时静默创建 `.env.local`
admin key，然后并行运行 Convex watcher 与 TanStack Start：

```bash
bun run dev
```

`--no-docker` 只适用于操作者已显式提供完整 self-hosted Convex URL/admin key 与 S3 endpoint/credential
的情况：

```bash
bun run dev -- --no-docker
```

常用分项命令：

```bash
bun reset                 # 破坏性重建当前本地 project，最终开放 /setup
bun db:reset              # 兼容别名，行为与 bun reset 相同
bun run infra:up          # 启动并健检 PostgreSQL/MinIO/Convex/dashboard
bun run convex:bootstrap  # admin key 写入 .env.local（0600，不输出 key）
bun run dev:convex        # 单独运行 function watcher
bun run dev:web           # 单独运行 TanStack Start
bun run infra:health
bun run infra:logs
bun run infra:down        # 不带 -v，不删除 volume
```

需要先核对目标而不改动任何状态，或在自动化中跳过交互时：

```bash
bun reset --dry-run
bun reset --yes             # 仅 CI/自动化；不会绕过安全检查
bun reset --no-web          # 完成空 deployment，但不启动 Web
bun reset --discard-deployment-env # 旧栈已损坏时明确放弃无法导出的旧 deployment env
```

`bun reset` 只允许本地 Docker daemon 和非 production 环境。它精确删除当前工作树 Compose project 的
Convex PostgreSQL、MinIO 与 Convex backend credential 三个 volume，随后重建 deployment env、admin
key 和 functions，并断言 Setup 状态为 `initialized=false, hasUsers=false`；默认还会重建当前工作树的 Web
镜像，再等待 `/setup` 可访问。旧 ERP 用户以及 Better Auth user/account/session 会被清空，旧 Cookie 和
admin key 全部失效；已有快照备份不删除，但命令不会自动替你创建新的恢复点。需要保留当前数据时先运行
`bun run convex:backup`，不要执行 reset。`infra:down` 始终保留 volume，与 reset 的用途严格不同。

标准 `web/Dockerfile` 用 BuildKit secret 读取 `HEROUI_AUTH_TOKEN`。如当前机器已有同一依赖版本下合法构建的
Web/LibreOffice 镜像，可在本地显式选择 `web/Dockerfile.cached-licensed-base`；该路径会先清空基座中的
应用文件，只复用授权依赖和 LibreOffice：

```bash
SYNIE_WEB_DOCKERFILE=web/Dockerfile.cached-licensed-base \
SYNIE_WEB_LICENSED_BASE_IMAGE=synie-web-print:plan007-final \
docker compose up -d --build
```

## 验证

```bash
bun run check                         # coverage/readiness/生成物/零残留/Web checks
bun run typecheck
bun run test
bun run build
bun run e2e:self-hosted               # auth + ERP + engines + S3 + PDF
bun run test:self-hosted-restore      # 隔离快照与六 bucket 恢复演练
```

`check:no-legacy-server` 扫描活动源码、配置与锁文件，禁止独立业务后端、业务 REST fallback、旧会话
token 和旧数据库工具重新进入当前栈。历史迁移文档与 committed coverage manifests 不属于活动运行面。

## 备份与恢复

```bash
bun run convex:backup -- /explicit/safe/output-directory
bun run convex:restore -- <backup-directory> <new-target-project>
bun run test:self-hosted-restore
```

备份由 Convex portable snapshot（含 Convex file storage）与六个 S3 bucket 组成。恢复只允许全新的独立 project/ports/volumes，
并对数据库记录和对象 bytes 做 SHA-256 对拍。演练清理不删除 volumes 或备份。生产职责、升级与告警见
[`docs/runbooks/convex-self-hosted.md`](docs/runbooks/convex-self-hosted.md)。

本地破坏性复位的安全边界见
[`docs/adr/2026-08-01-local-convex-development-reset.md`](docs/adr/2026-08-01-local-convex-development-reset.md)。

## 运行边界

- 浏览器业务数据请求只经 Convex generated API/ResourceBinding。
- Better Auth 只经 TanStack Start 同源 `/api/auth/*` cookie 路由。
- 文件上下载先经 Convex 鉴权，再使用短时 SigV4 URL 直连私有产品 bucket。
- TanStack Start 的 `/api/internal/print-worker/v1/*` 只是带 HMAC 的内部 xlsx→PDF Worker 契约，不读取业务数据。
- Convex backend/dashboard 必须固定同一版本；PostgreSQL、dashboard、S3 internal endpoint 不对公网暴露。

## HeroUI Pro

HeroUI token 只能放在已忽略的本地环境文件或 CI secret store：

- `HEROUI_PERSONAL_TOKEN`：个人本地工具。
- `HEROUI_AUTH_TOKEN`：非交互安装与标准 Web 镜像构建。

两者均不得提交、写入 Docker ARG/ENV 或输出到日志。

## 生产最低要求

- 以 secret manager 注入 Convex admin/deployment secrets、S3 credential 与 Worker HMAC，不复用本地默认值。
- Convex backend 与 PostgreSQL 17 同 region，升级前导出快照并演练空环境恢复。
- 使用通过 SigV4、private access、presigned URL、checksum 与 CORS 矩阵的第三方 S3 provider。
- 成对备份 Convex snapshot、六个 bucket、函数 Git SHA 和 secret reference，定期恢复而不只是生成备份。
