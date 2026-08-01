# 自托管 Convex 运维手册

本手册覆盖 Synie 自托管 Convex 的启动、备份、恢复与升级。平台决策见
[`../adr/2026-07-31-self-hosted-convex-platform.md`](../adr/2026-07-31-self-hosted-convex-platform.md)。

## 服务目标

| 参数 | 当前目标 |
|---|---:|
| RPO | ≤ 24 小时 |
| RTO | ≤ 4 小时 |

产品负责人调整目标时只修改本表，并同步备份频率、告警与演练频率。

## 拓扑与暴露面

- Convex backend 与 PostgreSQL 17 必须部署在同 region/低延迟网络。
- 外部只通过 TLS reverse proxy 暴露 Convex 3210（client）与 3211（HTTP actions）。
- Dashboard 6791、PostgreSQL、S3 internal endpoint 不直接公开；本地 Compose 全部绑定 loopback。
- backend/dashboard 必须使用同一个固定 tag；当前为
  `19431ea0dd90bc55ae58dbbd06d9aa045f97336f`。
- 本地 MinIO 仅是开发替身。生产使用通过兼容性闸门的第三方 S3-compatible provider，六个 bucket
  均为 private，产品 bucket 与五个 Convex bucket 使用不同 lifecycle/CORS 策略。

本地 MinIO Community 不再提供 per-bucket CORS，因此 MinIO API 不直接映射到宿主机。固定版本的
`minio-public` loopback proxy 在 `127.0.0.1:9000` 只为 `synie-product-files` 添加限定 origin 的
`GET/HEAD/PUT` CORS；五个 Convex 内部 bucket 即使经该端口诊断也不会收到 CORS capability。CORS
不是授权，六个 bucket 仍全部 private。最后一个官方预构建 MinIO 镜像早于 CVE-2025-62506 修复，
它只能使用 root key、绑定 loopback，不得用于生产、共享开发服务器或局域网暴露。生产 provider
必须原生支持 `synie-product-files` 的 bucket-level CORS。

产品 bucket 的 `uploads/` 与 `print-tmp/` 是可过期临时前缀，本地规则为 1 天；正式 `files/` 前缀
绝不配置 provider 自动过期，只能由 Convex 持久删除任务在挂接保护通过后删除。生产可按实际任务时长
延长临时保留期，但不得扩大规则到 `files/`。

## 本地启动与健康检查

首次启动：

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run dev:infra
bun run convex:bootstrap
```

`convex:bootstrap` 只在 `.env.local` 写入 self-host URL/site/admin key，文件权限为 `0600`，终端不显示
key。不要复制到 `.env.example`、issue、日志或 CI artifact。

重复健康检查：

```bash
bun run infra:health
curl -fsS http://127.0.0.1:3210/version
curl -fsS http://127.0.0.1:9000/minio/health/live
```

Compose 中浏览器/CLI 使用 `CONVEX_CLOUD_ORIGIN`，backend 内的 Node action 回调必须使用
`CONVEX_INTERNAL_ORIGIN=http://convex-backend:3210`。若普通 query/mutation 正常但第一个 Node action
报 `fetch failed`，先检查 backend 容器最终环境中的 `CONVEX_CLOUD_ORIGIN` 是否误写为宿主机
`127.0.0.1:<映射端口>`；容器内 loopback 不能访问宿主映射。修改后重建 backend，再用真实文件 action 验证。

门禁同时验证：两个 Convex image tag 相同、两个 PostgreSQL、六个 private bucket、产品 bucket
经 loopback proxy 的 CORS、内部 bucket 无 CORS、dashboard、backend `/version`、日志中的 PostgreSQL
连接与 S3 storage。若出现 SQLite/local storage fallback，立即停止部署并检查 `POSTGRES_URL`、region、
五个 bucket 变量和 S3 credential。

常用诊断：

```bash
bun run infra:logs
docker compose ps -a
docker compose logs convex-postgres minio minio-public minio-init convex-backend convex-dashboard
```

停止服务使用 `bun run infra:down`。该命令不带 `-v`；不得把删除 volume 当作日常故障恢复。

## 备份责任

每日备份是一个配对恢复单元：

1. 使用固定 workspace CLI 生成包含 Convex file storage 的 portable snapshot：

   ```bash
   bun run convex:backup -- /explicit/safe/output-directory
   ```

   脚本拒绝空路径、`/` 与 `~`，输出 source URL、snapshot SHA-256 与耗时。底层命令等价于
   `bunx convex export --include-file-storage --path <snapshot.zip>`。

2. 由 PostgreSQL provider 创建 `convex_self_hosted` 数据库备份/PITR 坐标。
3. 由 S3 provider 备份/版本化六个 bucket，并保存 inventory/checksum 报告。
4. 保存部署 Git SHA、backend/dashboard image digest、Convex function revision。
5. 保存 deployment env 的**名称和 secret-manager reference**；不要把 secret value 放进仓库或 snapshot。

Portable export 覆盖表数据与 Convex file storage，但不包含 Git 中的函数代码、deployment env、未执行
scheduled functions，也不代替产品 S3 bucket 的 provider backup。产品文件已经启用，恢复证据必须
额外逐 metadata key HEAD，对拍长度、MIME、provider checksum 与元数据 SHA-256；缺失或不符先隔离并
运行 reconciliation，不能把只恢复 Convex 数据库视为成功。

## 恢复演练

恢复只允许进入全新 Compose project/volume，不能覆盖开发者当前 stack：

```bash
COMPOSE_PROJECT_NAME=synie-source bun run convex:bootstrap
COMPOSE_PROJECT_NAME=synie-source \
  bun run test:self-hosted-restore -- /explicit/output synie-restore-YYYYMMDD
```

脚本在接触源数据前先断言目标 project 没有任何 container、network 或 volume；旧演练保留的 volume
也会令同名目标 fail closed，所以每次必须使用新名字。随后它把同一份本地 Convex functions 部署到
源/目标，以 internal action 在源栈写入一条 `infraRestoreSmoke` 记录、一份真实 Convex file-storage
对象和一条指向私有产品 bucket 正式对象的 `files` 元数据 → 使用 `--include-file-storage` export，
同时从产品 bucket 取得备份字节 → 在独立端口和全新 volumes 启动目标 → 生成目标 admin key、部署相同
functions、恢复产品对象 → `convex import --replace-all --yes` → 从目标读取两类文件。最终由本地脚本
对拍产品文件元数据、HEAD checksum 及源/目标真实字节 SHA-256；ZIP checksum 只用于标识备份，不作为
内容相等判据。演练结束只执行不带 `-v` 的 `down`，目标 volumes 保留供审计或人工清理。

生产恢复步骤：

1. 建立全新 PostgreSQL、S3 buckets、backend credential volume 和隔离 DNS。
2. 启动与备份记录相同的 backend/dashboard image。
3. 生成目标 admin key，通过环境变量向固定 CLI 注入，不放 CLI 参数或日志。
4. 部署相同 Git SHA 的 functions，恢复 deployment env。
5. 执行 `bunx convex import --replace-all --yes <snapshot.zip>`，并重新建立可重建 scheduled work。
6. 恢复/核对 PostgreSQL 与六个 S3 bucket；逐产品文件 key 做 HEAD/checksum，对缺失、孤儿与 checksum
   不符运行只报告不自动删除的 reconciliation，再运行表、projection、导入与应用 smoke。
7. 记录 source/target deployment、snapshot SHA-256、image/function revision、耗时与 RPO/RTO 结果。
8. 全部通过后才切 DNS/外部流量；失败时保留两边证据，不覆盖源环境。

## 升级

1. 确认 backend/dashboard 新 tag 的两个官方 manifest 均存在且架构匹配。
2. 在 staging 用生产大小 fixture 完成 export/import 与应用 smoke。
3. 停止外部写流量，生成最终 portable export，记录 env references，并确认 PostgreSQL/S3 备份完成。
4. 同时把 backend/dashboard 改成同一固定 tag，绝不改为 `latest`。
5. 等待日志中的 database migration completion，并运行 `infra:health`、auth/setup、业务和 file smoke。
6. 若 in-place migration 失败，在全新环境按上一节从 export/import 恢复；不要在损坏环境反复覆盖。
7. 恢复流量并记录 migration、image digest、函数 revision 与观察结果。

## 监控与告警

至少监控：

- `/version`、backend/dashboard readiness 与 image/version 漂移；
- PostgreSQL 可用性、连接池、延迟、磁盘与备份新鲜度；
- S3 请求错误/延迟、bucket/inventory/checksum 差异；
- query/mutation/action 队列、冲突重试、函数错误率与 transaction limits；
- scheduled/action backlog、最老任务年龄；
- upload/finalize 失败、过期 intent 清理量、产品对象 orphan/missing/checksum mismatch、删除重试年龄；
- OCR/行情 provider 错误率、行情 dead-letter、S3 internal/public endpoint 延迟；
- snapshot、PostgreSQL、S3 配对备份的时间与恢复演练结果。

客户端日志必须保持脱敏。Compose/CI 故障日志先经 `infra/convex/sanitize-logs.ts` 过滤；任何 admin key、
S3 secret、presigned URL 或业务 PII 泄漏都按 credential incident 处理并立即轮换。

## S3 provider 上线闸门

本地协议闸门：

```bash
bun run test:s3-compat
```

报告只记录 provider 类型、bucket、时间与通过的 capability 名称，不输出 endpoint、account 或 secret。
当前本地基线为 Compose MinIO；真实生产候选尚未指定，因此任何生产切流前必须在隔离环境用只读注入的
候选凭证再次运行 `infra/convex/s3-compat.ts`，确认 private、限定 CORS、SigV4/path-style、50MB、
服务端 PUT checksum、server-side CopyObject checksum、短时 GET/HEAD 与幂等删除全部通过。任一项失败即
停止上线，不得改用自写签名器或公开 bucket 绕过。
