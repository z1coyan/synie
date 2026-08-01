# Bun 独立后端 → 自托管 Convex 迁移完成记录

| 字段 | 值 |
|---|---|
| 文档类型 | 迁移完成记录 |
| 计划日期 | 2026-07-31 |
| 实施日期 | 2026-08-01 |
| 状态 | **完成** |
| 计划 | `advisor-plans/001`–`008` |
| 删除前提交 | `b6d5d7957c066cec7a380959259a1ac059693f37` |
| 删除前标签 | annotated tag `server-bun-final`（tag object `527abc38e66519dba6b38ddc2eda64414054362b`） |

## 结论

业务数据、身份映射、授权、查询、事务、事实、投影、任务和定时调度已经全部以自托管 Convex 为唯一
权威。当前运行栈只有 TanStack Start、固定版本 Convex backend/dashboard、Convex 专用 PostgreSQL 17
和六个私有 S3 bucket；TanStack server 只承载 SSR、Better Auth 同源接线和内部 PDF Worker。

独立 Bun/Hono/Kysely 后端、业务 PostgreSQL service、SQL migrations、JWT/localStorage、业务 `/api/v1`、
REST fallback、双后端模式和相关 workspace/CI/镜像入口均已从活动树删除。历史实现只通过 Git 标签整体
恢复，不在当前树保留半套兼容代码。

## 数据前提与切换策略

实施前再次确认项目尚未上线：没有生产用户、法定账务、正式附件或必须保留的业务 PostgreSQL 数据。
对应机器记录是 `convex/migration/cutoverReport.json`，SHA-256 为
`42b784089bdeb3a6c7ca40c9903845e4cbc24ff1dad6da814d1d55030bdd7cb6`。

因此切换采用“全新 Convex deployment → Setup 初始化”，没有 SQL→Convex importer、CDC、双写或新旧库
合并。若以后发现真实待保留数据，必须另立数据迁移 ADR 和恢复演练，不能重新引入隐式双轨。

## 覆盖与删除证据

最终 committed coverage 分母为：

- 100 个 Resource Catalog 资源：99 个 Convex verified，`sysStorages` 因唯一部署级 S3 provider 退役；
- 105 张旧 SQL 表全部映射；
- 279 个生产事务调用点归入 18 个 Convex transaction closures；
- 8 类外部 I/O 全部迁入 action/job/Worker 边界；
- Web active bindings、业务 REST 和跨后端 closure 均归零。

`bun run check:convex-cutover-readiness` 的最终输出为：

```text
legacyResources=0
unmappedTables=0
restBindings=0
unmappedTransactions=0
crossBackendClosures=0
```

删除范围包括整个 `server/`、其 Dockerfile/tests/SQL migrations、根 workspace 与数据库脚本、Web 的
`@synie/server`/Hono client/REST adapters、旧 Vite proxy、旧认证 token、旧 CI job 和业务 PostgreSQL
Compose service。`check:no-legacy-server` 留在本地 `check` 与 CI，防止上述运行面重新进入仓库。

## Setup 与业务闭环

最终 Setup 是两个用户步骤：首管理员创建；随后原子创建首公司、本币、三仓、科目模板、20 个常用币种、
26 个单位、16 个分类、内置角色、设置与编号规则。可选样例由 action 编排主数据、库存、销售、采购、
制造、委外、财务七个原子阶段；阶段完成后才推进恢复点，全部成功后才开放系统。

最终交付栈实测了 4 个跨 Better Auth component/应用表故障点、20 路并发初始化、完整样例、重复幂等、
登录/Actor/退出和两次 backend 重启。最终状态为 `hasUsers=true, initialized=true`，样例同时产生库存与
总账事实以及销售、采购、制造、委外、财务和薪资代表单据。

## 发布候选验收

以下门禁均在固定版本的真实 self-hosted stack 上通过：

- `bun run check && bun run typecheck && bun run test && bun run build`；
- `bun run e2e:self-hosted`，一次性覆盖 auth/Setup/ERP、浏览器 ResourceBinding、facts/projections、S3 与 PDF；
- 编号 101 次全部提交；热点库存 50 路竞争为 10 成功/40 拒绝；十年历史扫描 3,653 天、150 buckets；
- S3 private/product-only CORS、presigned PUT/GET/HEAD、copy checksum、provider checksum rejection、
  50MB single PUT 与幂等 delete 404；
- Worker down 时单条/批量 xlsx 降级；真实 LibreOffice 单条、批量、100 份 PDF、幂等和权限反例；
- production bundle 与镜像不含 `server/`、`/api/v1`、旧 client、Worker secret 或内部 Worker 浏览器调用；
- 删除前标签在隔离工作树完成 frozen install、typecheck、test 与旧 Docker build，未连接现有数据。

打印验收使用 LibreOffice `25.2.3.2`；单条、批量、100 份 PDF 分别为 22,740、25,045、263,520 bytes。

## 备份与恢复演练

恢复演练以 `t3code-093d8a8f` 为 source、全新 `synie-restore-b6095d011f` 为 target：

| 项目 | 结果 |
|---|---|
| 备份目录 | `infra/convex/backups/restore-smoke-2026-08-01T01-31-15.108Z-b6095d011f/`（gitignored，已保留） |
| portable snapshot | `synie-convex-2026-08-01T01-31-19-958Z.zip` |
| snapshot SHA-256 | `3038a139bb45002f7b6c1ea1d8dfaa71b939c73de437d3af2d703c255b3bc480` |
| snapshot 导出 | 0.41 秒 |
| snapshot 导入 | 6.70 秒 |
| 全流程恢复复核 | 30.10 秒 |
| 数据 | 17 documents、Convex file、产品 S3 object 与 I/O reconciliation 全部一致 |
| Convex file SHA-256 | `0a29e15e939a65999b75c750727a892b4f3382a6ea6aa123726d0166e9bc2935` |
| 产品文件 SHA-256 | `a620e67d54c84b2aa4948563d60b2db1fc5a58bcd3a2ded3139cb4263ad98a62` |

该 30.10 秒是本地小样本的实测恢复时间，不是生产 RTO 承诺；相对演练 marker 的 RPO 为 0。目标在
恢复后重启并再次按 bytes/hash 对拍。临时容器已停止，但 target/source volumes、六桶对象和备份均未删除。

## 最终本地 Compose

交付时保留运行的 project 是 `synie-cutover-final-093d8a8f`：

| 服务 | 本地地址/端口 |
|---|---|
| Web / auth / PDF Worker | `http://127.0.0.1:23000` |
| Convex backend | `http://127.0.0.1:23210` |
| Convex site | `http://127.0.0.1:23211` |
| Convex dashboard | `http://127.0.0.1:26791` |
| 产品 S3 proxy / MinIO console | `http://127.0.0.1:29000` / `http://127.0.0.1:29001` |
| Convex PostgreSQL | `127.0.0.1:25442` |

Convex backend/dashboard 固定版本是 `19431ea0dd90bc55ae58dbbd06d9aa045f97336f`；backend image digest 为
`sha256:467964cc6af57ba3e757e3e6cb1fa09a1c577803a19f03f0f42c9c4b134b070c`，dashboard 为
`sha256:5f4620ca0640ed863a8c5109123b9831157e889c6294e28c5e96ea0a62375efb`。Web image 是
`synie-web-print:cutover-final-093d8a8f`，digest 为
`sha256:a30f6f0ddb2e31a6e7563fed0be76d0713de897e41d5882e8e8d5c0c55c9d202`。部署的 Convex source-tree
fingerprint 为 `4178e0b1552ab7e3b42d89d5d6e35bf2483247c7ed15188f62488d7d28fd860a`；最终 Git 提交是可复现的
functions revision 坐标。

六个且仅六个 private bucket 已由 health gate 复核；Web root、Worker health、Convex version 与 dashboard
均成功，所有常驻容器 healthy，`minio-init` 按设计 exit 0。Web 容器启用只读根文件系统、drop ALL
capabilities、256 PID、2 GiB/2 CPU 限制。

自动闭环使用的随机探针管理员不作为交付凭据。日常本地登录账号 `admin` 已通过内置管理员角色和首公司
授权创建，并实际完成登录、session 查询与退出；初始密码仅写入 gitignored、权限 0600 的
`infra/convex/backups/final-local-admin-synie-cutover-final-093d8a8f.txt`。用于创建账号的一次性管理 session
已经删除，凭据没有进入命令输出、镜像、deployment env 或 Git。

## 回滚与保留策略

- 代码/发布回滚：从 `server-bun-final` 整体构建旧 release，不能在当前树局部恢复 `server/`；
- 新栈恢复：将同一时点的 Convex portable snapshot、五个 Convex bucket、产品 bucket、函数 Git SHA 与
  secret reference 成对恢复；
- 新旧数据不做在线合并或双写；
- 本迁移没有执行 `docker compose down -v`、`docker volume rm`、bucket cleanup 或备份删除；
- 旧 volume/bucket 的观察期后清理是单独的破坏性运维动作，必须由用户明确指定目标并再次授权。

相关架构边界见 [Convex-only 应用边界 ADR](../adr/2026-08-01-convex-only-application-boundary.md)，操作步骤与
生产责任见 [自托管 Convex runbook](../runbooks/convex-self-hosted.md)。
