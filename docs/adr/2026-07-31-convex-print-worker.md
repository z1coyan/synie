# ADR：Convex 打印调度与 TanStack Start PDF Worker

- 日期：2026-07-31
- 状态：已接受
- 修订：[2026-07-23 打印模板管线](2026-07-23-print-template.md)的执行面，并取代
  [打印全资源自动接入](2026-07-23-print-universal-catalog.md)中“未经 DocBuilder 验收即自动可打印”的结论。

## 背景

模板填充是可确定的 TypeScript 计算，LibreOffice 转换则依赖子进程、字体和可写临时
目录。自托管 Convex 是业务事实与任务状态的唯一权威，不应被安装 LibreOffice；浏览器也
不应持有 Worker 密钥或直接调用内部端点。

## 决策

1. Convex 在一次一致读取中校验 Actor、公司范围、权限、模板与最多 100 个单据，
   然后使用 sealed Resource Catalog 与显式 DocBuilder 生成 `PrintDoc`。首期可打印资源为
   `sales.order` 与 `mfg.work_order`；新资源必须先完成 DocBuilder、权限及 golden test，
   不因仅出现在权限目录而自动开放。
2. Excel 导出由 Convex action 填充 `renderSheets`、写入私有产品 S3 的 `print-tmp/`，再返回
   5 分钟签名下载 URL。它不检查 Worker 健康，Worker 完全停机时仍可用。
3. PDF 打印由 Convex 填充 `renderPages` 后建立短命 `printJobs`。状态机为
   `queued → running → succeeded | retryable | failed | expired`，使用 attempt + lease token 防止
   过期 Worker 提交，最多尝试 5 次。任务和临时对象在 24 小时内清理。
4. TanStack Start 的 serverful production 容器只实现 xlsx→PDF。Worker 通过预签 GET/PUT
   与 S3 交换 bytes，不读 Convex、模板目录或业务数据，也不持有 S3 长期凭证。
   production image 固定 Bun/Debian，安装 LibreOffice Calc 与 Noto CJK，非 root、只读根文件
   系统，只允许受限 `/tmp`。
5. 唯一可替换面是 `POST /api/internal/print-worker/v1/jobs/:jobId/execute`。v1 JSON 只含
   job/attempt/deadline、输入大小与 SHA-256、两个短时签名 URL；请求使用
   timestamp + raw-body SHA-256 的 HMAC，容许 60 秒时钟偏差。内部 HTTP host 必须显式
   allowlist，其他目标只允许 HTTPS 且 DNS/IP 不得落入 loopback、link-local、metadata
   或私网。GET 流量、checksum、PDF magic/大小、PUT checksum 和返回 schema 全部 fail-closed。
6. 用户在原对话框内订阅任务并等待，成功后打开 `inline` PDF 签名 URL。
   `printJobs` 是 crash-safe 执行状态，不是打印历史、任务中心或审计事实。

## 运行与可观测性

- readiness 必须同时通过 production server route、`soffice --version`、Noto CJK 字体与
  `/tmp` 写入；liveness 不发起转换。公开 ingress 不路由 `/api/internal/print-worker/**`。
- 结构化事件 `print_job_schedule`、`print_dispatch_*`、`print_worker_*`、`print_cleanup`
  提供 backlog/lease、attempt/result、duration、input/output bytes 与 cleanup 数据；标签不包含
  resource id、文件名、用户名或签名 URL。
- 轮换、故障处理和告警见 [PDF Worker 运维手册](../runbooks/print-worker.md)。

## 后果

- 业务权限、一致读、幂等和结果授权仍只在 Convex，TanStack 不成为第二个业务后端。
- 打印可因 Worker/S3 故障进入重试或明确失败，但 Excel 导出的故障域独立。
- 未来 Rust Worker 只有在通过实现无关 contract suite、真实 workbook、故障注入和性能
  基线后，才可仅替换 `PRINT_WORKER_URL`。
