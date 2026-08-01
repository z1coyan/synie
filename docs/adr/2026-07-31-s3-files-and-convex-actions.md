# 私有 S3 产品文件与 Convex 外部 I/O

- 日期：2026-07-31
- 状态：已采纳
- 关联：Plan 006；[自托管 Convex 平台 ADR](./2026-07-31-self-hosted-convex-platform.md)

## 背景

旧独立后端同时维护 local、S3-compatible、OSS 三类动态存储接入，并由业务服务中转完整文件。目标架构要求 Convex 成为业务数据、授权、任务和调度的唯一权威，但 Convex function 参数/响应限制不适合中转 50MB 文件，deterministic mutation 也不能承载 S3、OCR、行情 HTTP 或文件解析等副作用。

银行导入最多 5,000 行，考勤导入最多 100,000 行；若把网络读取、解析和全部结果塞进一次 mutation，既无法恢复，也不能可靠维持“整批提交前不可见、提交后整体可见”的业务语义。旧行情定时器又依赖进程内 `setInterval`，容器重启会丢失调度状态。

## 决策

### 产品文件

- 产品字节只存一个由运维配置的私有 S3-compatible provider；Convex 保存文件元数据、宿主挂接、授权、上传意向、删除任务与对账报告。`sysStorages`、动态 provider CRUD 与本地产品文件路径在 Convex 目标退役。
- 浏览器计算 SHA-256，向 Convex mutation 申请 10 分钟上传意向，再使用 action 签发的 URL 把 0–50MB 字节直接 PUT 到 `uploads/`。签名固定长度、MIME 与 checksum；provider 必须在 PUT 时验证 checksum。
- finalize action 通过内部 endpoint HEAD 校验长度、MIME 与服务端 checksum，再以 S3 server-side CopyObject 把对象复制到不可变 `files/` 正式前缀并删除暂存对象；CopyObject 后再次 HEAD 对拍。最终 mutation 原子创建文件元数据与可选挂接，重复 finalize 返回同一文件。
- `uploads/` 与 `print-tmp/` 可配置短期 lifecycle；`files/` 不配置自动过期。过期 intent、失败删除和未知孤儿由持久任务清理或报告，正式对象只能在挂接保护与业务删除状态机通过后删除。
- 下载/预览每次先按显式 owner resolver 检查宿主存在、read capability 与公司范围，再签发 5 分钟 bearer URL。未知宿主 fail-closed；URL 不落审计 changes、不缓存、不写日志。

### 外部 I/O 与任务

- S3、OCR、行情 provider、XLSX/DAT 读取解析均在 Convex Node action；mutation/query 不 import Node builtins、不直接 `fetch`。OCR 凭证只存在 Convex deployment env/secret manager，财务业务表只呈现“已配置/未配置”。
- action 只把小参数、进度和结果写回 internal mutation；文件 bytes 始终从 S3 internal endpoint 有界读取，不进入 scheduled args、Convex document 或浏览器以外的上传 body。
- 银行与考勤导入使用持久 `ioJobs`、lease、chunk number/hash 与 parent status。银行以父批次一次翻转实现整体可见；考勤分块构建新的打卡/日考勤 generation，全部完成后一次切换 generation。任务崩溃或租约过期可继续，不重不漏。
- Convex cron 每分钟唤醒持久 scheduler/job runner。行情的 schedule slot、lease、重试、dead-letter 与幂等键落库；禁用时不外呼，单项失败不覆盖已成功项。
- 外部副作用清单由 `convex/migration/ioManifest.ts` 封闭管理；PDF/LibreOffice 是唯一留给 Plan 007 的 server-runtime I/O。

### 自托管回调地址

自托管 backend 内的 Node action 会通过 `CONVEX_CLOUD_ORIGIN` 回调同一 deployment 的 query/mutation。Compose 容器不能使用浏览器/CLI 的宿主机映射地址（例如 `127.0.0.1:37210`），否则 action 容器内的 loopback 指向自身错误端口并报 `fetch failed`。

因此外部 `CONVEX_CLOUD_ORIGIN` 继续供 dashboard、CLI 与浏览器使用；backend 容器内单独注入 `CONVEX_INTERNAL_ORIGIN`，默认 `http://convex-backend:3210`。生产编排也必须提供 backend/Node action 可达的内部服务地址。

## 后果

- 本地 MinIO 与生产第三方 provider 共用完全相同的 AWS SDK/SigV4 路径；更换 provider 前必须通过 private、CORS、presigned PUT/GET/HEAD、50MB、checksum、server-side copy 和幂等删除门禁，禁止增加 provider-specific signer 或业务分支。
- 产品 bucket 不在 Convex portable snapshot 内。完整恢复单元是 Convex snapshot/PostgreSQL、五个 Convex bucket、产品 bucket、函数 revision 与 deployment secret references；恢复后必须逐 metadata key HEAD 并对拍 checksum。
- 上传从浏览器到 S3 是两阶段协议，网络失败可能留下暂存或正式孤儿；持久 cleanup/reconciliation 将其变成可观察、可重试状态，而不是假装跨 S3 与 Convex 存在分布式事务。
- 生产候选 provider 尚未指定时，本地 MinIO 通过只能证明协议实现正确，不能替代上线前针对真实 provider 的同一 compatibility suite。

## 验证证据

- `bun run test:s3-compat` 覆盖私有访问、产品 bucket CORS、签名 PUT/GET/HEAD、checksum mismatch、50MB、server-side copy checksum 与重复 DELETE/404。
- `bun run test:self-hosted-resources` 在隔离真实栈验证浏览器直传、短时下载、银行 XLSX、考勤 DAT/generation、OCR 未配置、行情禁用、文件维护/对账及 `sysStorages` 退役。
- `bun run test:self-hosted-restore -- <output> <fresh-project>` 配对恢复 Convex 原生 file storage 与产品 S3 对象，并对拍 Convex 产品文件元数据、HEAD checksum 和真实字节 SHA-256。
