# Plan 006: 迁移 S3 文件、导入、OCR、定时任务与外部 I/O

> **执行者说明**：产品文件字节必须在第三方 S3 兼容存储（本地为 Plan 001 的 MinIO），不得
> 进入 Convex document/argument。所有网络 I/O 在 action，所有数据库状态转换在 mutation。
> `sysStorages` 按既定目标退役，不重新实现动态 provider CRUD。遇到 STOP 条件立即报告。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- convex compose.yaml infra/convex server/src/platform/files server/src/modules/finance server/src/modules/hr server/src/jobs web/app/lib/files.ts web/app/components/synie-attachment-panel web/app/components/synie-preview docs/产品文档 docs/adr CONTEXT.md`
> 有变化时逐项比对下列事实；不一致即 STOP。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/003-cut-over-resource-plane.md`
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

文件、OCR、导入、行情拉取和定时任务是“整个后端迁到 Convex”最容易漏掉的边角，也是 Convex
deterministic mutation 不能直接承载的 I/O。目标是一个清晰的两层模型：Convex 保存授权、
元数据、job/idempotency 状态；S3 保存 bytes；Node action 只做网络/解析并调用 internal mutation。
本地 MinIO 与生产第三方 provider 共享同一协议，不保留数据库内动态 storage 选择。

## 当前状态

- `server/src/platform/files/README.md:1-19` 定义不可变文件 ≤50MB、SHA-256、local/S3/OSS 三种
  storage、全局一个默认；表为 `sys_file/sys_storage/sys_attachment`。
- `server/src/platform/files/service.ts:36,117-207` 当前把整文件读进 Bun，服务端计算 SHA-256，
  写 object storage 后在 SQL 事务创建 file/attachment/audit，失败删除 object。
- `server/src/platform/files/owner-registry.ts:9-75` 对 ownerType fail-closed，验证宿主存在、read
  permission 和 company scope；这一授权语义必须保留。
- `server/src/platform/files/object-storage.ts:53-200` 项目自行实现 S3 SigV4 和 presigned GET，并
  同时维护 local storage；目标应改用标准 AWS SDK/presigner，减少维护面。
- `web/app/lib/files.ts:51-113` 是前端唯一 upload/download/attach seam；页面不应直接改为自写 S3。
- `server/src/modules/finance/bank-parser.ts:8,55-109` 银行 Excel 最多 5,000 行。
- `server/src/modules/hr/rules.ts:14-17,55-65` 考勤导入固定 UTC+8，最多 100,000 行。
- `server/src/modules/finance/ocr.ts:6-16,88-175` 使用 Node crypto + external fetch，文件最多 10MB；
  这是 Convex Node action，而不是 mutation。
- `server/src/jobs/marketsched/scheduler.ts:9-25,114-136` 以进程内 `setInterval` 每分钟 tick；容器重启
  会丢 state，目标应使用 Convex cron/scheduled function + 持久 lease。
- Convex function args 最大 16MiB、Node action args 5MiB、HTTP action response 20MiB；因此 50MB
  文件不能经函数参数/response 中转：<https://docs.convex.dev/production/state/limits>
- Convex scheduled functions 与 cron 的官方语义：
  <https://docs.convex.dev/scheduling/scheduled-functions>
- 用户已固定：本地 MinIO，生产第三方 S3 compatible；产品附件不使用 Convex 原生 file storage。

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| S3 compatibility | `bun run test:s3-compat` | local MinIO 全能力通过 |
| 文件 tests | `bun test convex/files web/app/lib/files.test.ts` | 全部通过 |
| Job/import tests | `bun test convex/jobs convex/domains/*/imports` | 全部通过 |
| Self-host integration | `bun test convex/test/self-hosted-io.integration.test.ts` | 全部通过 |
| Web | `cd web && bun run check && bun test && bun run build && bun run typecheck` | exit 0 |
| 全仓 | `bun run typecheck && bun run test` | exit 0 |

## 范围

**范围内：**

- `convex/files/**`、files/attachments/upload intents/job schema/indexes
- `convex/jobs/**`、`convex/crons.ts`
- `convex/domains/finance/{bankImport,ocr,marketActions}.ts` 及 internal mutations
- `convex/domains/hr/attendanceImport.ts` 及 staging/projection mutations
- 其他现有 external fetch/webhook 的明确 action/http action（由 manifest 列全）
- `packages/shared/src/files.ts` 与 import/job contracts（如需）
- `web/app/lib/files.ts`
- `web/app/components/synie-attachment-panel/**`、`synie-preview/**` 及 FileThumb consumers
- 导入/OCR/行情页面的 transport 接线与测试
- `infra/convex/**` S3 compatibility/lifecycle 脚本、`.env.example` 对应变量
- `convex/migration/**`：`sysStorages` retired、IO endpoint coverage
- `docs/adr/2026-07-31-s3-files-and-convex-actions.md`（新建）
- `docs/产品文档/系统管理.md`、资金银行/人力薪酬/行情/OCR 相关篇（用户行为有变化处）
- `CONTEXT.md`（只有术语/业务边界变化时）
- `advisor-plans/README.md` 状态

**范围外：**

- Convex 的五个内部 S3 bucket 部署（Plan 001 已做）；这里只消费配置。
- PDF 转换（Plan 007）。
- Rust worker、Redis、Kafka、外部队列。
- 保留 `sysStorages` 动态 CRUD、local filesystem product storage 或自写 SigV4。
- 让 S3 bucket/object 公开，或返回不经业务鉴权的长期 URL。
- 把 50MB bytes/base64 放入 Convex DB、function arg、scheduled arg 或 HTTP action response。

## Git 工作流

- 分支：`advisor/006-convex-io-jobs`
- S3 文件、导入 staging、OCR/行情、cron/UI 分逻辑提交。
- 建议提交：`feat(convex): 迁移 S3 文件与异步任务`。
- 不 push、不开 PR；第三方 provider credentials 永不落 Git/log。

## 步骤

### Step 1: 把第三方 S3 compatibility 变成部署闸门

实现 `infra/convex/s3-compat` 测试，对 Plan 001 MinIO 和生产候选 provider 验证：

- path-style/endpoint + SigV4；
- private bucket、CORS；
- presigned PUT/GET/HEAD/DELETE（DELETE 可只由 server credential）；
- `Content-Length`、content type、content disposition；
- 50MB single PUT；
- `ChecksumSHA256`（或 provider 明确兼容的服务端校验 header）在 PUT 时由存储验证、HEAD 可读；
- conditional/idempotent delete、404；
- public endpoint 生成的 URL 在浏览器可达，internal endpoint 在 Convex action 可达。

把生产 provider 的测试报告（不含 endpoint account/secret）记录在 runbook。AWS SDK 与 presigner
固定版本，使用两个 client：internal I/O endpoint 与 public signing endpoint。

**Verify**：`bun run test:s3-compat` 对 MinIO 全绿；带生产候选只读 secret 环境运行也全绿。

### Step 2: 建立不可变产品文件和 upload intent 协议

schema 至少包括 `files`、`attachments`、`uploadIntents`、`fileDeleteJobs`。对象 key 由服务端生成，
含随机 id，不接受客户端完整 key。实现：

1. authenticated mutation `createUploadIntent` 校验 `sys.file:create`、filename/type/size≤50MB、
   可选 ownerType/ownerId 的权限和公司范围，写短时 intent；
2. Node action 为 intent 生成 10 分钟内的 presigned PUT，签入 exact length/type/checksum；
3. 浏览器直接 PUT S3，不经过 TanStack/Convex body；
4. Node action HEAD 验证 object、size/type/checksum，再调用 internal mutation 原子创建 file、可选
   attachment、audit，并把 intent 标 finalized；
5. 重复 finalize 返回同一 file（idempotent）；过期/不匹配 object 删除并标失败。

SHA-256 由浏览器 WebCrypto 计算并作为 S3 checksum 发送，**必须由 provider 在 PUT 时验证**；不能
只把客户端声称的 hash 写元数据。S3 object 始终 private。

**Verify**：覆盖 0/50MB/50MB+1、checksum mismatch、过期、重复 finalize、上传成功后 DB 失败、
orphan cleanup；浏览器 network 证明 bytes 直达 `localhost:9000` 而非 Convex/TanStack。

### Step 3: 保留附件宿主与下载授权的 fail-closed 语义

把 owner registry 改为类型化 owner resolvers，不允许运行期动态表名：

- 每个 ownerType 指向具体 internal query，检查存在、read capability、company scope，返回 companyId。
- attach 只允许本人刚上传/有明确管理权限的 file，保持现有语义。
- download/preview 先鉴权 file 或至少一个可见 attachment，再由 Node action 返回 5 分钟 presigned
  GET；设置 filename/content type/nosniff。URL 是短时 bearer，不进日志/cache/审计 changes。
- delete 先 mutation 把 metadata 标 `deleting` 并解除允许的 attachments，再 action 删除 object，
  internal mutation finalize；重试幂等。失败保持可重试状态，不假装已删。
- orphan intent/object 有定时清理；已引用不可变 object 不覆盖，只新建 file。

保持 `web/app/lib/files.ts` 作为唯一前端 seam，内部改为 intent→PUT→finalize/get-url；AttachmentPanel、
Preview、FileThumb API 不让页面感知 S3。

**Verify**：ownerType 未注册、宿主不存在、无 permission、跨公司、URL 过期、本人/他人文件、删除
失败重试全部 fail-closed；搜索生产页面无直接 S3 fetch/presigner 代码（仅 `lib/files.ts`）。

### Step 4: 以 parent status + staged chunks 迁移大导入

为 bank(≤5k) 与 attendance(≤100k) 统一 job 原语，但保留各域 parser/规则：

- 浏览器先按文件协议上传，mutation 创建 import job（idempotency key = actor+file+template+参数）。
- Node action 从 internal S3 endpoint 流式/有界读取解析；不能把 bytes 放 scheduled args。
- parsed rows 以 100–500 条/块写 staging docs；每块 internal mutation 校验 job lease、chunk no、hash，
  重复写 no-op。
- 查询 staging 必须先验证 parent job；未 `committed` 的 rows 对业务 query 完全不可见。
- bank rows 天然按 import parent 查询，parent 单 mutation flip 即原子可见。
- attendance 以 parent/chunk 为事实；employee/day read projection 使用新 generation 分块构建，全部
  对拍后单 mutation 切 generation。不要 patch 100k rows 伪装一次事务。
- job 记录 progress/error/cancel/lease，action crash 后可恢复；错误只暴露行号和稳定中文原因。

保留 UTC+8、bad/dup counts、unknown employee 等现有规则。若现有业务要求“100k raw punches 在一次
SQL 事务立刻全局可见”，用 generation pointer 达成等价可见性，不改成逐块半可见。

**Verify**：5,001 bank rows 拒绝；100,000 attendance 成功、100,001 拒绝；在任一 chunk/投影步骤
kill action 后重试不重不漏，commit 前业务查询为 0，generation flip 后一次看到完整结果。

### Step 5: 把 OCR 与所有外部 HTTP 调用放入 Node action

为 OCR：

- action 重新鉴权 Actor/command capability，读取 S3 object（≤10MB）并验证 MIME/size；
- access key/secret 从 Convex deployment env/secret manager 读取，不再存在业务 table/ResourceDocument；
- 复用当前 ACS3 signing/mapping 的纯函数与 fixtures；network error/非 JSON/provider error 映射稳定
  中文 validation，不泄漏 credential/request signature；
- 结果仅返回草稿 prefill，用户保存单据时由领域 mutation 重新验证。

扫描 `server/src` 的 `fetch`/Node crypto/fs/process usage，把每个 endpoint 录入 IO manifest：target
action、timeout、retry/idempotency、secret location、最终 internal mutation。纯 webhook 接收用
Convex HTTP action，必须签名验证、防重放、再调 internal mutation。

**Verify**：IO manifest 100% coverage；OCR fixtures/10MB+1/network/provider errors 通过；架构测试
禁止 public mutation/query import Node builtins 或调用 fetch。

### Step 6: 用 cron + persisted lease 替代进程内 timer

建立 `convex/crons.ts` 和 job runner：

- cron 每分钟触发 internal scheduler mutation/action，不依赖容器进程 `setInterval`。
- schedule decision state、last run、next eligible、lease owner/expiry 持久化；并发 tick 只有一个获 lease。
- action 拉行情；每个 provider/result 用 idempotency key 写 internal mutation，部分失败按现有 item
  结果记录，不覆盖成功项。
- retry 使用显式 backoff/max attempts/dead-letter 状态；管理 UI 能看最后成功/失败摘要，不展示 secret。
- 所有 scheduled args 只传 IDs/small config；large payload 存 S3/DB。

对 imports、file cleanup、projection rebuild、print dispatch（Plan 007）复用同一个轻量 job/lease
原语，不再引 Redis/队列。

**Verify**：同时触发 20 ticks 只有一个 fetch；backend 重启/lease expiry 后恢复；重复 provider response
不产生重复 price point；禁用 schedule 时零外呼。

### Step 7: 退役动态 storage 资源并更新 UI/文档

在 Convex manifest 将 `sysStorages` 标 `retired`，删除 convex-mode 的存储 CRUD/menu/binding：

- 只保留“文件”元数据/附件管理；provider endpoint/bucket/credential 归部署环境和 runbook。
- 本地/生产代码路径完全相同，只换 env；禁止 `if minio` 业务分支。
- `docs/产品文档/系统管理.md` 删除用户可管理 local/S3/OSS 接入点的描述，说明由运维配置一个
  S3 兼容存储；不暴露 credential 名称。
- OCR secret 从财务 UI 移除时同步对应产品文档，并提供清晰“未配置，请联系管理员”状态。

legacy 资源/路由暂不删除，Plan 008 清场；convex mode 不得 fallback。

**Verify**：active resource denominator 正确减少一项；convex-mode 菜单/ResourceBinding 无
`sysStorages`，文件功能仍全绿；`rg -n "local.*S3.*OSS|sysStorages" convex web/app` 只命中明确
legacy/migration fixture。

### Step 8: 补齐生命周期、备份与灾难恢复

- product bucket lifecycle：过期 upload intents/orphans、临时 import/print objects、保留中的正式文件
  分 prefix；不得让 lifecycle 误删正式 attachment。
- S3 inventory/reconciliation job 对拍 Convex file metadata 与 object keys，只报告/隔离 orphan，默认
  不自动删除不明对象。
- Plan 001 backup/restore runbook 加入 product bucket；恢复后对每个 metadata key HEAD/checksum。
- 告警：upload/finalize failure、orphan count、job backlog/lease age、OCR/market error、S3 latency。

**Verify**：在临时 stack 做 Convex snapshot + 六 bucket backup/restore，file preview、导入 job、checksum
全部对拍；故意缺一个 object 时 reconciliation 报告精确 file id/key 且不崩溃。

## 测试计划

- S3 compat：MinIO + 生产候选 provider，50MB、checksum、CORS、signed URL、private policy。
- Files：intent/finalize/idempotency/orphan、owner auth/company、download expiry、delete retry。
- Imports：5k bank、100k attendance、chunk crash/retry/cancel、原子可见 generation。
- OCR：MIME/size、sign fixture、network/provider error、secret redaction。
- Scheduler：lease/restart/backoff/idempotency/disabled，20 concurrent ticks。
- UI：AttachmentPanel/Preview/upload progress/error，页面只经 `lib/files.ts`。
- Restore：metadata↔object checksum 全量对拍。

## 完成条件

- [ ] 50MB bytes 全程直达 S3，不进入 Convex/TanStack function body。
- [ ] 所有 product objects private，signed URL 前均重做 permission/company check。
- [ ] owner registry、不可变文件、SHA-256、50MB 语义保留。
- [ ] 银行5k/考勤100k 可 crash-safe 分块并原子可见，无重复/半成品。
- [ ] OCR/行情/其它 fetch 全在 Node action，最终写入 internal mutation 幂等。
- [ ] 进程内 timer 为零；cron/lease 重启可恢复。
- [ ] `sysStorages` 在 Convex target 正式 retired，本地 MinIO/生产第三方只换配置。
- [ ] S3/Convex 联合恢复演练通过；所有 tests/build/typecheck 全绿。
- [ ] ADR/产品文档更新，secret scan 无命中，范围外无改动，索引 DONE。

## STOP 条件

- 生产候选 S3 provider 不支持本计划 compatibility contract，尤其 private presigned request 或服务端
  校验 checksum；不要回退自写 provider-specific signer。
- owner permission/company 只能在发 URL 后检查，或 URL 必须长期公开。
- 100k import 无法通过 generation/parent visibility 保持业务原子可见，且产品不接受 staged job。
- Node action 需要把 >5MiB bytes 放 args，或 HTTP action 返回 >20MiB bytes。
- 必须把 S3/OCR secret 存普通业务文档或发送浏览器。
- scheduled action 重试会产生不可去重的外部副作用。
- 当前文件/导入业务规则与摘录漂移。

## 维护说明

- S3 compatibility suite 是更换第三方 provider 的唯一入口；新 provider 全绿后只换 env，不改业务码。
- `sysStorages` 退役是刻意的维护面缩减。若未来要多租户多 provider，应作为新产品需求建 ADR，
  不恢复旧动态表。
- Job parent/status/chunk/lease 是通用原语，但各域 parser、校验、commit projection 仍归各域，不建
  万能 workflow DSL。
- 产品 bucket 不在 Convex snapshot 内；任何只备份 Convex 数据库、不备份 S3 的方案都不完整。
