# Plan 007: 在 TanStack Start 落地可替换的 PDF Worker

> **执行者说明**：首期 PDF 转换必须运行在 TanStack Start 的服务端容器；Convex 负责鉴权、
> 模板填充、任务状态与调度，S3 负责临时 xlsx/pdf bytes。不要把 LibreOffice 装进 Convex，
> 不要让浏览器直接调用内部 Worker，也不要提前建设 Rust 服务。遇到 STOP 条件立即报告。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- server/src/platform/printing web/app/lib/print.ts web/app/components/synie-print web/app/routes/_app/system/print-templates.tsx web/vite.config.ts web/package.json compose.yaml docs/adr/2026-07-23-print-template.md docs/adr/2026-07-23-print-universal-catalog.md docs/产品文档/系统管理.md CONTEXT.md`
> 有变化时逐项比对下列事实；不一致即 STOP。

## 状态

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/005-migrate-business-domains.md`,
  `advisor-plans/006-move-files-imports-and-jobs.md`
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

当前打印引擎已经把确定性的 xlsx 模板填充与有进程/临时目录依赖的 LibreOffice 转换分开；迁到
Convex 后应继续保留这条深 seam。目标不是把 TanStack Start 变成第二套业务后端，而是让它只承担
一个可替换的二进制转换能力：下载已填充 xlsx、运行 `soffice`、上传 PDF、返回小型结果。这样首期
只维护一套 Web 部署，性能到瓶颈时 Rust 服务实现同一 v1 HTTP contract 即可替换。

## 当前状态

- `server/src/platform/printing/renderer.ts:1-105` 是 zip+XML 的确定性模板填充，`renderPages` 用于
  打印、`renderSheets` 用于 Excel 导出；它不应跟 LibreOffice Worker 一起搬入 Web。
- `server/src/platform/printing/service.ts:334-417` 校验批量上限 100、读取模板/单据、填充 xlsx，只有
  print 分支调用 converter；export 在 converter 不可用时仍可工作。
- `server/src/platform/printing/pdf.ts:30-142` 的 `PDFConverter` 使用独立临时 profile、120 秒 timeout、
  默认并发 2、进程终止和 finally cleanup；这些是迁移行为基线。
- `server/src/platform/printing/types.ts:78` 固定 `MAX_RENDER_BATCH = 100`。
- `docs/adr/2026-07-23-print-template.md:5-13` 固定“一条填充引擎两个产物”、LibreOffice 只做哑转换、
  单 xlsx 批量转换、模板 page setup 为版式权威、打印不留历史、PDF 故障不影响导出。
- `docs/产品文档/系统管理.md:89-102` 固定模板管理、入口、批量 100 和降级语义，但当前仍写 Go/REST，
  实施时必须改为 Convex + 内部 Worker 的实际边界。
- `web/vite.config.ts:8-35` 目前只有 Vite 开发服务和 `/api/v1` proxy；`web/package.json` 没有生产
  `start` 命令，仓库也没有 `web/Dockerfile`。因此“放在 TanStack Start”尚不等于已有可承载
  `child_process`、可写临时目录和 120 秒请求的生产 runtime。
- TanStack Start 官方支持 server/API routes 和 Node/Docker/Bun 部署；Vite 生产构建需产出并启动
  真正的 server bundle，不能用静态托管或把 `vite preview` 当 Worker：
  <https://tanstack.com/start/latest/docs/framework/react/guide/hosting>
- TanStack 的 execution model 要求 server-only 模块显式隔离，否则同构代码可能进入客户端 bundle：
  <https://tanstack.com/start/latest/docs/framework/react/guide/execution-model>
- Convex action 可执行外部 HTTP/Node.js，并把用户 auth 自动传播给其 `runQuery`/`runMutation`；
  scheduled function 本身没有用户 auth，因此必须只消费先前授权后生成的任务：
  <https://docs.convex.dev/functions/actions>
- LibreOffice 官方确认 `--headless` 用于无 UI 运行：
  <https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html>
- 用户已固定：本地开发启动 MinIO，生产使用第三方 S3 compatible；PDF 首期在 TanStack Start，
  有性能瓶颈后才考虑 Rust。

## 目标数据流

```text
浏览器
  ├─ export action ─┐
  └─ print action ──┼─> Convex：鉴权 + 一次一致读取 + 填充 xlsx
                    │       ├─ export：上传临时 xlsx → 短时下载 URL
                    │       └─ print：上传临时 xlsx → transient printJob
                    │                                  │
                    │                           scheduled dispatch action
                    │                                  │ HMAC + presigned GET/PUT
                    │                                  v
                    └──────────────────── TanStack Start internal Worker
                                                       │ soffice
                                                       v
                                               S3 临时 PDF → 浏览器
```

TanStack Worker **不读取 Convex、业务数据或模板目录**，也不持有 S3 长期 credential。它只接受一次
转换所需的短时签名 URL。`printJobs` 仅是 crash-safe 的执行状态，24 小时内清除，不是打印历史或
用户可查询的任务中心。

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| Renderer | `bun test convex/platform/printing` | golden/模板/权限 tests 全绿 |
| Worker unit | `cd web && bun test app/server/printing` | converter/contract/鉴权全绿 |
| Web production | `cd web && bun run build && bun run typecheck` | server bundle 与类型检查 exit 0 |
| Worker image | `docker build -f web/Dockerfile -t synie-web-print:test .` | 镜像构建成功 |
| Local E2E | `bun run test:printing-self-hosted` | Convex + MinIO + Web/LibreOffice 全链通过 |
| Web checks | `cd web && bun run check && bun test && bun run e2e` | 全部通过 |
| 全仓 | `bun run typecheck && bun run test && bun run build` | exit 0 |

## 范围

**范围内：**

- `packages/shared/src/print-worker.ts`、`packages/shared/src/index.ts`：稳定的 v1 wire contract
- `convex/platform/printing/{catalog,templates,builders,render,zip,jobs,actions}.ts` 及测试
- `convex/schema.ts` 的 print template metadata、transient job/indexes
- `convex/crons.ts` 的 print retry/purge（复用 Plan 006 job/lease 原语）
- `web/app/server/printing/{converter,worker,auth}.ts` 及测试
- `web/app/routes/api/internal/print-worker/v1/jobs/$jobId/execute.ts`
- `web/app/routes/api/internal/print-worker/v1/health.ts`
- `web/app/lib/print.ts`、`web/app/components/synie-print/**`、打印模板页/ResourceBinding 接线
- `web/vite.config.ts`、`web/package.json`、`web/Dockerfile`、`.dockerignore`
- `compose.yaml`/`infra/convex/**` 中 Web Worker 服务、internal URL、healthcheck、临时对象 lifecycle
- `.env.example` 中 Worker URL/HMAC/timeout/concurrency 的无 secret 示例
- `docs/adr/2026-07-31-convex-print-worker.md`（新建，修订旧 ADR 的执行面）
- `docs/产品文档/系统管理.md`、`CONTEXT.md` 的实现边界与同步等待语义
- `advisor-plans/README.md` 状态

**范围外：**

- Rust Worker、独立队列、Redis、Kafka、PDF 合并服务、水平扩容自动化。
- 把模板填充/DocBuilder 搬到 TanStack，或让 Worker 接收 resource/id 并查询业务数据。
- Convex 原生 file storage；临时 xlsx/pdf 仍进 Plan 006 的产品 S3 bucket。
- 永久 print history、下载 PDF 业务按钮、任务中心、异步大批量、提高 100 条上限。
- 将 signed S3 URL、HMAC secret、模板内容、业务数据写入普通日志/错误消息。
- 静态/edge/serverless Web 部署；本计划需要 serverful Bun/Node 容器、LibreOffice 与可写 `/tmp`。

## Git 工作流

- 分支：`advisor/007-tanstack-print-worker`
- shared contract、Convex renderer/job、TanStack Worker/container、UI/docs 分逻辑提交。
- 建议提交：`feat(printing): 以 TanStack Start worker 转换 PDF`。
- 不 push、不开 PR；不要提交真实 S3 URL、HMAC secret 或生成文件。

## 步骤

### Step 1: 先证明 TanStack Start 的 production server runtime

按当前依赖版本采用官方 Vite/Nitro 的 Bun 或 Node server build 形状，在 `web/package.json` 加真正的
`start` 命令，在 `web/vite.config.ts` 配好 server bundle，并新建多阶段 `web/Dockerfile`：

- build stage 安装冻结 lockfile 并执行 `vite build`；runtime 只复制产物与运行依赖。
- runtime 基于固定 tag/digest 的 Debian 系镜像，安装 LibreOffice Calc、Noto CJK/fontconfig、
  `coreutils timeout` 和最小 CA cert；构建日志记录 `soffice --version`。
- 非 root 用户运行；仅 `/tmp` 可写；设置内存/CPU/pid 限制，不挂源码和 Docker socket。
- `start` 直接启动构建出的 TanStack server，不用 `vite dev`/`vite preview`。
- Compose 本地仍由 Plan 001 同时启动 PostgreSQL、MinIO、Convex backend/dashboard；本步骤只增加
  Web 容器及其对 MinIO internal endpoint 的网络可达性。

先建一个 server route smoke endpoint，在**构建后的镜像**中验证 route、`child_process`、`/tmp`、
字体和 `soffice` 可用；确认反向代理对 Worker 路径允许至少 `PRINT_WORKER_TIMEOUT_MS + 15s`，默认
135 秒。Worker 路径应只在容器内网暴露；公开 ingress 明确拒绝或不路由它。

**Verify**：镜像中 `bun run start` 后 SSR 与 internal health 均成功，health 返回固定 schema 的
`ready=true`、converter/version/font capability；只运行静态产物或删掉 `soffice` 时 readiness 失败。

### Step 2: 固定可由 Rust 原样实现的 v1 Worker contract

在 `packages/shared/src/print-worker.ts` 用验证器定义并导出以下语义，禁止 Worker import Convex 类型：

```ts
type ConvertRequestV1 = {
  version: 1
  jobId: string
  attempt: number
  deadlineAt: number
  input: { getUrl: string; size: number; sha256: string }
  output: { putUrl: string; headers: Record<string, string> }
}

type ConvertResponseV1 = {
  version: 1
  jobId: string
  output: { size: number; sha256: string; contentType: 'application/pdf' }
  converter: { engine: 'libreoffice'; version: string }
}
```

请求为 `POST /api/internal/print-worker/v1/jobs/:jobId/execute`。用
`X-Synie-Timestamp` + `X-Synie-Signature = HMAC-SHA256(secret, timestamp + "\\n" + sha256(rawBody))`
鉴权，constant-time compare，时间漂移最多 60 秒；secret 至少 32 随机 bytes，只在 Convex deployment
env 与 Web server env。jobId path/body 必须相同，未知字段拒绝，body 有很小上限。签名失败统一 401，
不回显签名、raw body 或 presigned URL。

协议版本、HTTP status 与稳定错误码写 contract tests：`bad_request`、`unauthorized`、
`input_mismatch`、`timeout`、`convert_failed`、`output_failed`、`busy`。响应不携带 stdout/stderr；详细
诊断只做截断且脱敏的内部日志。

**Verify**：shared fixtures 同时驱动 caller 和 Worker；body/timestamp/signature/path 任一篡改即 401/400，
同 job/attempt 重放只覆盖同一临时 object 且结果一致，不产生第二个业务任务。

### Step 3: 把模板目录、DocBuilder 与纯 renderer 迁入 Convex

从当前 `catalog.ts`、`docbuilder.ts`、`format.ts`、`renderer.ts`、`zip.ts`、`types.ts` 移植行为，
但以 Plan 003 的 sealed Resource Catalog 和 Plan 005 的领域 read helper 为事实源：

- field catalog 自动覆盖 active printable resources，继续排除 id/FK/timestamp/sensitive fields；
- 每个 resource 的打印 capability、permission、公司范围由同一个 ResourceBinding manifest 决定；
- 一个 internal query 在同一 read transaction 中完成 actor/template/resource/ids 鉴权与最多 100 条
  `PrintDoc` 装配，禁止 action 连续调用多个 query 拼不一致快照；
- renderer/format/zip 是 plain TypeScript 纯模块；Node action 只负责从 S3 读取模板、调用 renderer、
  计算 checksum 并上传临时 xlsx；不在 mutation 中 import Node builtin。
- template metadata 在 Convex，原始 `.xlsx` 由 Plan 006 私有 S3 file/object 保存；上传 validation action
  下载后检查占位符/page setup，再由单个 internal mutation 原子创建/替换 metadata。

保留现有 golden workbook、placeholder、0 条明细、公式/page setup、同名单 sheet、中文 filename 与
100 条边界 tests。生成 xlsx 超过明确上限时返回 validation，不把 bytes 放 action 返回值。

**Verify**：同一 template + fixture 的旧/新 xlsx 结构和可见值 golden 等价；field catalog coverage 与
active printable resources 1:1；无权限/跨公司/模板不匹配/101 ids 全部在下载模板前失败。

### Step 4: 让 Excel 导出完全绕过 PDF Worker

public `export` action 执行一次 Step 3 prepare/read，填充 `renderSheets`，将 xlsx 上传
`synie-product-files` 的 `tmp/printing/...` prefix，并在再次确认 job owner 后返回 5 分钟 presigned GET。
元数据记录 expiry/checksum/size，仅为 cleanup/idempotency，不作为打印历史；对象生命周期短于 24 小时。

LibreOffice health、Worker URL/HMAC 均不得成为 export 前置。前端仍表现为“导出 Excel”直接下载；
若 signed URL 已过期，重新鉴权后可在对象 TTL 内重签，不重新读业务记录生成不同版本。

**Verify**：关闭/删除 LibreOffice 和 Worker 容器，单条/批量 export 仍成功；浏览器 bytes 从本地 MinIO
或生产 S3 直下，不经过 Convex/TanStack response body；跨用户重签失败。

### Step 5: 建立短命、可恢复且不构成打印历史的 print job

public `startPrint` action 在用户 auth 上下文中完成一次 prepare/read、`renderPages` 和 xlsx 上传，然后
调用一个 internal mutation 创建 `printJobs` 并调度 dispatch。字段只含：owner actor/company、状态、
attempt/lease/deadline、input/output object key+hash+size、稳定错误码和 created/expires timestamps；不保存
模板 bytes、业务 `PrintDoc`、单据内容或长期 signed URL。

状态机固定：`queued → running → succeeded | retryable | failed | expired`。创建 mutation 用
actor+template+resource+ids+request nonce 做短窗幂等；claim/complete/fail 都校验 attempt 与 lease token。
浏览器在当前打印对话框订阅本人的 job，成功后经重新鉴权的 action 取得 5 分钟 PDF URL；不新增历史页、
管理资源、审计业务记录或永久下载入口。cron 在 24 小时内 purge job 与临时 objects。

若 initial action 在 job 创建前失败，不留 job；创建后客户端断线，scheduled dispatch 仍完成，用户可在
当前会话用 job id 重接。ADR 明确“transient execution state 不是打印历史”。

**Verify**：双击、刷新、断网、action crash、lease expiry 均不产生重复业务任务/永久记录；其他 actor、
跨公司和权限撤销后拿不到 PDF URL；24 小时后 job/object 均清除。

### Step 6: 在 Convex dispatch action 中调用 Worker

internal scheduled Node action 每次只处理一个已 claim job：

1. 从 Plan 006 S3 client 为 xlsx 生成短时 GET、为固定 output key 生成校验 content-type/checksum 的 PUT；
2. 构造 v1 body、HMAC 签名，用 `AbortSignal.timeout` 在 job deadline 前 POST internal Worker URL；
3. 校验 status、content-type、response schema、jobId 和 response size；
4. 对 output key 执行 HEAD，确认 provider 验证后的 size/checksum/content-type 与响应一致；
5. 单个 internal mutation 按 lease/attempt 标 succeeded，或记录稳定 retryable/terminal code。

不要把业务 auth token、Convex admin/deploy key或 S3 credential 发给 Worker。网络/5xx/`busy` 可指数退避，
validation/input checksum/明确 convert failure 不盲重试；总 attempts 和对象 TTL 固定。调用结果不依赖
Worker 回调，因此后续 Rust 服务也无需 Convex credential。

**Verify**：在 POST 前、转换后 PUT 前、PUT 后 response 前、HEAD 后 complete 前分别 kill 进程；lease
恢复后最终恰一份有效 PDF，或在上限后稳定 failed，无永远 running job。

### Step 7: 在 TanStack server-only Worker 中复用并加固 converter

把 `pdf.ts` 的转换行为迁到 `web/app/server/printing/converter.ts`，模块入口使用 server-only guard；
route handler 只做 contract/auth/size/deadline 校验并调用 worker service：

- 只允许 HTTPS 或容器内受控 HTTP 的 presigned URL host allowlist；防 SSRF 到 loopback/metadata/private
  地址，MinIO internal hostname 通过显式配置加入。
- GET 时限制 content-length 和实际流量（默认 50MB），校验 xlsx SHA-256 后才写输入临时文件。
- 每任务独立 `mkdtemp`、input/output/profile；保留 `--headless --norestore --nolockcheck`、独立
  `UserInstallation`、120 秒 timeout、TERM→KILL、finally recursive cleanup。
- 每 Web 进程 semaphore 默认 2；满载快速返回 `busy`，由 Convex lease/backoff 重试，不在 HTTP
  handler 内排无限队列。
- 输出必须是一个非空 PDF、magic `%PDF-`、size 上限/checksum 正确；PUT 带 contract 指定 headers。
- stdout/stderr 最多保留 200 Unicode chars 且 redact URL/secret/path；正常日志只有 jobId/attempt/duration/
  byte counts/error code。

route 不能 import React/UI/Convex client，Worker 不能解析 template placeholder 或读取数据库。

**Verify**：fake executable 覆盖 not found/timeout/nonzero/no output/concurrency/abort/cleanup；真实
LibreOffice 覆盖中文字体、横竖向、页边距/打印区域、多页、100 条 batch；SSRF/超长/chunked overrun/
checksum mismatch 均在执行 `soffice` 前拒绝。

### Step 8: 接通打印 UI，保持既有产品语义

改 `web/app/lib/print.ts` 和 `TemplatePrintDialog` 只调用 Convex printing API：

- 点击后立即显示同一对话框内“正在生成”，拿到 jobId 后订阅 queued/running/result；不建任务中心。
- 成功用短时 URL 打开浏览器 PDF 预览；打印/另存仍是浏览器能力，不新增“下载 PDF”。
- stable error code 映射现有中文：Worker 未配置/不可用、超时、模板错误、转换失败；不显示 raw stderr。
- export 使用独立 action，不查询 Worker health；无模板、权限、默认模板、单/批入口与 100 上限不变。
- 页面不得调用 internal Worker route、拼 S3 URL 或持有 HMAC。

更新系统管理产品文档和 `CONTEXT.md`：把 REST/Go/Bun 文件流改为“Convex 填充与调度 + S3 短时
产物 + TanStack internal converter”；用户仍在当前操作中等待，无历史任务与产品级异步队列。

**Verify**：Playwright 覆盖单/批 print/export、默认/切换模板、刷新重接、PDF down export success、
权限撤销；浏览器网络没有 `/api/internal/print-worker`，也没有业务 `/api/v1`。

### Step 9: 补齐部署、可观测性和 Rust 替换闸门

- readiness 同时检查 server route、`soffice --version`、字体、`/tmp` 写入；liveness 不启动转换。
- 指标：queued/running age、attempt/result、Worker saturation、convert duration/input/output bytes、cleanup；
  标签不含 resource ids、filename、signed URL、用户名。
- 告警：最老 queued 超 2 分钟、失败率/timeout、stale lease、tmp 磁盘、S3/Worker health。
- runbook：HMAC 双 secret 轮换窗口、Web rolling restart、手动 retry/cancel、orphan reconcile、禁用
  Worker 时 export 验证。
- 写 `infra/convex/print-worker-contract-test`，只依赖 v1 HTTP contract 和 S3；未来 Rust candidate 必须
  先通过同一 suite、real workbook golden、故障注入和性能基线，再仅替换 `PRINT_WORKER_URL`。

记录单实例 concurrency=2 下的 p50/p95、100-record worst case、RSS/tmp 峰值和吞吐；这里只建立基线，
不据此提前引入 Rust。

**Verify**：本地 MinIO 完整 E2E、生产候选 S3 compatibility 环境 E2E、容器重启/secret rotation/
Worker disabled runbook 演练；contract suite 不 import Web/Convex 源码也可运行。

## 测试计划

- Pure renderer：旧 golden、placeholder、sheet/page setup、公式、中文、0/1/100/101 条。
- Contract/auth：共享 fixtures、schema/version、HMAC 篡改/过期、错误码、response size。
- Worker unit：fake soffice、timeout/kill/cleanup、并发 2/busy、SSRF、流量/hash/PDF magic。
- Real container：固定 LibreOffice/Noto CJK 的 xlsx→PDF golden visual/text/page count smoke。
- Convex job：auth/company、一次一致 prepare、lease/attempt/idempotency、retry/terminal/purge/reconnect。
- S3：本地 MinIO与生产候选 provider 的 presigned GET/PUT/HEAD/checksum/TTL。
- UI：print/export 降级切割、刷新、中文错误、浏览器不访问 Worker、不出现永久 history。
- Operations：四个 crash point、Web rolling restart、HMAC rotation、backup/restore 后临时任务处理。

## 完成条件

- [ ] 模板填充/DocBuilder 在 Convex，TanStack Worker 只做 xlsx→PDF。
- [ ] 本地 Compose 启动 MinIO 和带 LibreOffice/Noto CJK 的 TanStack Start production server 容器。
- [ ] 生产第三方 S3 与本地 MinIO 使用同一 Worker contract/code path，只换配置。
- [ ] xlsx/pdf bytes 只经 S3 signed URL，不进入 Convex args/response 或 Worker JSON。
- [ ] export 在 Worker 完全不可用时仍成功；print 保持单 xlsx、批量 100、模板 page setup 语义。
- [ ] job lease/idempotency/crash recovery 全绿，24 小时内清除且没有用户可见打印历史。
- [ ] Worker endpoint 内网 + HMAC + SSRF/size/hash 防护，secret/URL/业务内容不进日志。
- [ ] production image、real LibreOffice E2E、Web/Convex/self-host tests/build/typecheck 全绿。
- [ ] ADR、产品文档、CONTEXT 更新；Rust contract suite 可独立运行；索引 DONE。

## STOP 条件

- TanStack production deployment 只能静态/edge/serverless，不能可靠运行 child process、写临时目录或
  承受 135 秒 internal request；先更换为 serverful container runtime再继续。
- 当前 TanStack 依赖版本无法产出可启动的 production server bundle，或 server route 只在 dev 生效。
- 业务合法的 100 条 `PrintDoc` 无法在单次一致 read/render limits 内完成，且拆分会改变单 xlsx 原子输出。
- Worker 必须持有 Convex admin key、数据库访问或 S3 长期 credential 才能工作。
- 生产第三方 S3 不能完成 Plan 006 已要求的 presigned GET/PUT/HEAD/checksum contract。
- 反向代理/平台硬限制低于转换 timeout，且 internal route 无法绕过该限制。
- 为稳定运行必须把打印历史永久化、改变版式、放宽权限或让导出依赖 Worker。
- 当前打印 ADR、产品文档和行为测试对同一规则冲突，无法确定权威。

## 维护说明

- `ConvertRequestV1`/`ConvertResponseV1` 是以后 Rust 替换面的唯一契约；业务 resource、Actor、模板、
  Convex IDs 都不得泄漏成 Worker domain model。
- Web 扩容时总 LibreOffice concurrency = replicas × per-process limit；先用指标调整副本/limit，确认 CPU、
  RSS、tmp 与 S3 吞吐后再判断是否值得 Rust 化。
- 升级 TanStack、Bun/Node、LibreOffice、字体或基础镜像时都重跑 production image + real workbook golden；
  不只跑 TypeScript unit tests。
- 临时 job/object 是运行机制，不是审计事实；需要“打印留痕”时必须作为独立产品需求建模，不能延长
  transient TTL 偷渡实现。
