# ADR：以 PostgreSQL 17 与 S3 承载自托管 Convex

2026-07-31，状态：已实施；2026-08-01 已完成全部业务切流与旧服务清场。本 ADR 固定运行平台，
最终应用边界与禁止回退约束见
[`2026-08-01-convex-only-application-boundary.md`](2026-08-01-convex-only-application-boundary.md)。

## 背景

Synie 尚未上线、没有需要搬迁的生产业务数据。当前独立 Bun/Hono/Kysely 后端与业务 PostgreSQL
使应用同时维护 transport、事务和数据库实现。后端迁移的目标是让 Convex 成为业务数据、授权、
query/mutation/action、定时任务与状态的唯一事实源，同时保留专门适合 binary/process 工作负载的
边界：S3 保存 bytes，TanStack Start 后续只承载同源认证与 LibreOffice PDF 转换。

自托管会把数据库、对象存储、版本、备份和恢复责任交回项目，因此应用迁移前必须先证明目标栈
可以固定版本、重复启动并从 portable snapshot 恢复。

## 决策

### 固定同版本 backend/dashboard

本地与 CI 固定官方 GHCR 完整 commit tag：

```text
19431ea0dd90bc55ae58dbbd06d9aa045f97336f
```

该 tag 的 backend/dashboard 均有 amd64/arm64 manifest；不使用 `latest`。Compose 同时把该值注入
`CONVEX_RELEASE_VERSION_DEV`，所以 `/version` 可与实际 image tag 对拍。CLI 固定为
`convex@1.42.3`，通过 Bun workspace 安装，不在运维命令中在线获取未固定版本。

### PostgreSQL 17 是 Convex 唯一持久数据库

Convex 使用独立 `convex-postgres` 和 volume，数据库为 `convex_self_hosted`。backend 的
`POSTGRES_URL` 不含数据库名；`INSTANCE_NAME=convex-self-hosted` 决定数据库名。迁移期的独立业务
PostgreSQL 从未与该库复用、同步或双写，并已随旧服务退出当前 Compose 与工作树。

`/convex/data` 仍使用小型持久 volume 保存 instance name/secret。即使业务数据已在 PostgreSQL/S3，
丢失该 secret 仍会使既有 admin key 失效。

### S3 是 Convex storage 与产品文件的 bytes 层

同一 provider 建立五个 Convex 专用 private bucket：

- `convex-snapshot-exports`
- `convex-snapshot-imports`
- `convex-modules`
- `convex-user-files`
- `convex-search-indexes`

另建 private `synie-product-files`。本地用 MinIO，生产使用通过兼容性测试的第三方 S3-compatible
provider。业务代码分别接收容器可达的 internal endpoint 与浏览器可达的 public endpoint，避免把
`minio:9000` 签入浏览器 URL。Convex 的 `AWS_REGION` 与五个 bucket 变量必须齐全；健康门禁从日志
确认 S3 已启用，禁止静默回退本地文件系统。

MinIO Community 自 2025 年起不支持 per-bucket CORS，因此 MinIO API 不直接发布到宿主机。本地以
固定版本的 loopback proxy 暴露 `9000`：只为 `synie-product-files` 添加限定 origin 的
`GET/HEAD/PUT` CORS，并剥离五个 Convex 内部 bucket 的 CORS headers。所有 bucket 仍为 private，
应用只会为产品 bucket 签发浏览器 URL；生产 provider 必须原生支持产品 bucket 独立 CORS。最后一个
官方预构建 MinIO 镜像缺少 CVE-2025-62506 的后续修复，因此它只作为 loopback、root-key、本地开发
替身；禁止用于生产或暴露到局域网。若本地安全政策禁止该镜像，应从官方
`RELEASE.2025-10-15T17-29-55Z` 源码构建后再启用，而不是换用未知第三方镜像。

### 安全与可恢复性

- 本地端口全部只绑定 `127.0.0.1`；生产只由 TLS reverse proxy 暴露 3210/3211，dashboard 不公开。
- backend 设置客户端日志脱敏并关闭匿名 beacon；secret 仅从部署环境/secret manager 注入。
- backend 使用容器内 `http://convex-backend:3211` 作为 site origin；浏览器与 CLI 使用单独的公开
  site URL。二者禁止复用宿主机 loopback 地址，避免容器内认证请求错误回连自身宿主端口。
- admin key 由官方容器脚本生成，自动化静默写入 gitignored、`0600` 的 `.env.local`。
- portable export 必须包含 Convex file storage；PostgreSQL 与六个 S3 bucket 另由 provider 备份。
- 恢复必须使用全新 Compose project/volume，部署相同 Git SHA 与函数 revision，恢复 env 后才放流。
- `docker compose down` 不带 `-v`；本计划不删除既有 volume、bucket 或备份。

## 否决方案

- **Convex Cloud**：目标明确为开源自托管，不能把身份、数据或部署事实转回商业云。
- **生产 SQLite**：多公司财务 ERP 直接使用官方已测试的 PostgreSQL 17，避免上线后二次迁移。
- **复用旧业务 PostgreSQL**：会把迁移变成隐式耦合或双写，恢复边界也无法独立验证。
- **产品附件进入 Convex document/function body**：文件上限和授权语义不匹配；S3 专门保存 bytes。
- **浮动 image tag**：backend/dashboard 或数据 migration 漂移将破坏可重复恢复。
- **公开 MinIO/bucket**：CORS 不是授权；所有访问仍需 server credential 或短时 presigned URL。

## 后果

- 开发机和 CI 只启动 Convex PostgreSQL、Convex backend/dashboard 与 MinIO；不存在业务数据库或
  进程模式开关。
- Convex PostgreSQL、五个内部 S3 bucket、产品 bucket、函数代码与 deployment env 共同组成恢复单元；
  单独保存任一部分都不构成完整备份。
- 更换生产 S3 provider 前必须通过 SigV4、private、presigned PUT/GET/HEAD、checksum、CORS 和 lifecycle
  compatibility suite；不能在业务代码增加 provider 分支。
- 运维步骤与验证证据统一记录在
  [`../runbooks/convex-self-hosted.md`](../runbooks/convex-self-hosted.md)。
- 身份/session 与 ERP Actor 的分层见
  [`2026-07-31-convex-auth-and-actor.md`](2026-07-31-convex-auth-and-actor.md)。

## 实施证据

- 固定 backend/dashboard 的 manifests 均存在，`/version` 返回完整 tag。
- 真实本地栈日志包含 `Connected to Postgres database: convex-self-hosted` 与
  `S3 { ... } storage is configured.`。
- MinIO 初始化连续执行可重复得到六个且仅六个 private bucket。
- portable restore 门禁使用一条隔离表记录、一份真实 Convex file-storage 对象及一份私有产品 S3
  对象；全新目标 import/产品 bucket 恢复后必须从 Convex 接口读回元数据与原生文件，并由本地脚本按
  HEAD checksum 和真实文件字节 SHA-256 对拍。ZIP checksum 只标识备份，不代替内容校验；临时 stack
  停止时保留 volume。产品文件协议与外部 I/O 细节见
  [`2026-07-31-s3-files-and-convex-actions.md`](2026-07-31-s3-files-and-convex-actions.md)。
