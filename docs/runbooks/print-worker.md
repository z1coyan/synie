# PDF Worker 运维手册

架构边界见
[`../adr/2026-07-31-convex-print-worker.md`](../adr/2026-07-31-convex-print-worker.md)。Worker 只是
TanStack Start production 容器内的 xlsx→PDF 转换能力，业务任务状态在 Convex，字节在私有 S3。

## 健康与发布闸门

```bash
curl -fsS http://127.0.0.1:3000/api/internal/print-worker/v1/health
bun test convex/platform/printing
cd web && bun test app/server/printing && bun run build && bun run typecheck
docker build -f web/Dockerfile -t synie-web-print:test .
bun run test:printing-self-hosted
```

readiness 必须返回 `version=1`、`ready=true`、LibreOffice 版本、可写 `/tmp` 和 CJK 字体。
外部反向代理只暴露 Web/SSR 与同源 auth，必须拒绝或不路由
`/api/internal/print-worker/**`。容器以非 root、只读根文件系统运行，不挂载源码或 Docker socket。

`infra/convex/print-worker-contract-test.ts` 是实现无关的验收闸门：它只依赖 v1 HTTP
contract 和 S3，不 import Web/Convex 实现。替换引擎或升级 Bun、LibreOffice、字体、基础
镜像时都必须重跑真实容器 smoke。

## 指标与告警

从结构化事件聚合以下指标，不得把 resource id、filename、username、HMAC 或签名 URL
做成 label：

- `print_job_schedule`：queued/retryable/stale-running 数量和最老任务年龄；
- `print_dispatch_claimed|succeeded|failed`：attempt、结果、端到端 duration、input/output bytes；
- `print_worker_complete|failed`：Worker duration、饱和/busy、timeout、转换与上传失败；
- `print_cleanup`：每轮删除的 artifact/job 数，配合 S3 `print-tmp/` inventory 查 orphan。

默认告警：最老 queued/retryable 超过 2 分钟；stale lease 连续两个调度周期存在；5 分钟
timeout/failed 比例超过 5%；Worker `busy` 超过 10%；`/tmp` 超过 70%；S3 GET/PUT/HEAD
错误或 readiness 失败。单实例并发默认为 2，扩容前先用 smoke 报告记录单条、批量和
100 条基线；不用未采样的 p95 推测容量。

## HMAC 轮换

1. 生成至少 32 随机 bytes 的新 secret，只写 secret manager。
2. 先滚动发布 Web：新值设为 `PRINT_WORKER_HMAC_SECRET`，旧值放
   `PRINT_WORKER_HMAC_PREVIOUS_SECRET`。确认所有副本 readiness 正常。
3. 再把 Convex deployment 的 `PRINT_WORKER_HMAC_SECRET` 切为新值，观察成功与 401 计数。
4. 至少等待 10 分钟且无旧签名请求后，清空 previous secret 并再次滚动发布。

不同时翻转两端，不把 secret 放进 Compose 命令行、日志、issue 或浏览器 bundle。

## 故障处理

- Worker 停机：保持 Convex/S3 可用，先验证 Excel 导出仍成功；查 readiness、容器资源、
  `soffice --version`、字体和 `/tmp`。恢复后 due/stale lease 会由每分钟调度器重拾。
- 单任务卡死：不直接改 S3 对象或伪造 complete。等 135 秒 lease 过期后调度器将重试；
  若为输入/checksum/模板的终止错误，让用户修正后重新发起，不强制重放。
- 取消：当前产品没有用户可见的长任务中心；紧急停止新转换时先从内网隔离
  Worker，让已领取 lease 自然超时。任务与临时对象保留到 TTL，不人工删除作为
  “取消”。
- orphan 对账：先比对 Convex `printArtifacts` 与 S3 `print-tmp/` inventory，只报告差异；
  确认 TTL 与备份后由既有 cleanup 删除，不运行临时 bucket 递归清空。

Web 滚动重启安全：转换失联会由 Convex lease/backoff 重试，输出键固定且经 HEAD
checksum 复核。任何手工处理都不得记录 presigned URL、raw body、stdout/stderr 全文或业务内容。
