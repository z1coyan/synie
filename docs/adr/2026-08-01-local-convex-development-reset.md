# ADR：本地 Convex 开发复位与 Setup-ready 边界

2026-08-01，状态：已实施。

## 背景

旧独立后端曾提供 `db:reset`，把开发数据库恢复成“已迁移、未 Setup”。切换为自托管 Convex 后，业务
状态不再只存在一个可截断的 PostgreSQL schema：Convex PostgreSQL、五个内部 S3 bucket、产品文件
bucket、backend instance credential、deployment env 与 functions 共同决定 deployment 是否可用。
只清 PostgreSQL、只删业务表或保留旧 admin key 都会制造不可恢复的半新状态。

同时，认证与业务 Setup 必须在真正的空 deployment 验证。仅启动容器和生成 admin key 不足以创建首
用户；Better Auth、产品 S3 与 PDF Worker 的 deployment env 必须先注入，当前 functions 也必须先部署。
全新工作树应有一条明确命令完成这些准备，而不要求开发者手工拼接 `docker compose down -v`、
`convex env set` 与 `convex dev --once`。

## 决策

### 命令契约

- 正式入口为 `bun reset`；为既有开发习惯保留 `bun db:reset`，但它只是同一 runner 的别名，不维护
  第二套行为。
- 无参数交互执行必须显示解析后的 Compose project 和将删除的三个 volume，并要求操作者逐字输入
  project 名。输入不一致或 stdin 非交互时拒绝。
- `--yes` 只供 CI/自动化跳过输入，不跳过 production、Docker daemon、资源归属或删除集合检查。
- `--dry-run` 完成全部只读解析并报告计划，不停止容器、不写凭据、不删除或创建资源。
- `--no-web` 完成空 deployment、env、functions 与 Setup 状态验证，但不构建或启动 Web；默认模式还必须
  重建当前工作树 Web 镜像、等待健康并确认 `/setup` 可访问。
- 默认先导出旧 deployment env；旧栈自身已损坏时，只有显式 `--discard-deployment-env` 才可跳过导出并
  从 Compose/`.env` 重建必需项。该开关不放宽任何删除归属门禁。

完成 `cp .env.example .env` 与 `bun install --frozen-lockfile` 后，全新本地工作树可以直接运行
`bun reset` 得到 setup-ready 环境，无需 seed 管理员或示例数据。

### 精确的数据边界

复位只删除当前工作树 Compose config 所解析 project 的三个命名 volume：

- `convex-postgres`：Convex 表、Better Auth component、deployment env 与调度状态；
- `synie-minio`：五个 Convex bucket 与一个产品文件 bucket 的全部对象；
- `convex-backend-data`：instance secret 等 backend credential。

runner 不接受用户传入任意 volume/path/glob，不执行全局 prune，不删除镜像、其他 Compose project 或
`infra/convex/backups/` 下既有快照与配对产品对象备份。备份保留不等于自动创建恢复点；需要保留当前
状态时，操作者必须在复位前显式完成 portable snapshot 与 S3 配对备份。

### 安全门禁

runner 在发生第一项写操作前必须：

1. 拒绝 `NODE_ENV=production`、`SYNIE_ENV=production`、`APP_ENV=production` 及等价 production 标识；
2. 拒绝远程 Docker host/context，只允许本机 Docker Engine；
3. 拒绝任何 Convex Cloud deploy key/token/deployment 选择变量，所有 CLI 命令都使用经清理的
   self-hosted URL/admin key 环境；
4. 从当前工作树的 Compose config 解析 project，并校验现有 container 的 config path、working directory
   与所有目标资源 label；同名但属于其他工作树、外部环境或无法证明归属的资源一律 fail closed；
5. 明确列出且只允许上述三个 project volume；任一非预期 project 资源都先停止而不是顺带删除；
6. 在交互确认或显式 `--yes` 之前保持完全只读。

因此 `SYNIE_BIND_HOST=0.0.0.0` 的受控 Tailscale 浏览器验证仍可使用本命令，但这不把远程 Docker 或
生产 deployment 纳入授权范围。

### 重建顺序与完成条件

确认后 runner 按固定顺序：

1. 停止并移除当前 project 的容器/网络及三个目标 volume；
2. 重建 PostgreSQL 17、MinIO/六个 private bucket、Convex backend credential 与 dashboard，并通过
   基础设施健康检查；
3. 生成新的 self-hosted admin key，原子覆盖 gitignored、`0600` 的本地凭据；
4. 从同一份本地配置派生公开应用 origin、Better Auth secret、S3 endpoint/credential 与 PDF Worker
   HMAC，以权限 `0600` 的临时文件注入 deployment env，任何日志都不得输出 secret；
5. 一次性部署当前工作树的 Convex schema、components 与 functions；
6. 经公开 Setup query 断言恰为 `initialized=false, hasUsers=false`；
7. 默认重建并启动当前工作树 Web，等待健康检查并确认 `/setup` 可访问；`--no-web` 只省略此步骤。

删除前的 deployment env 以 gitignored、`0600` recovery 文件暂存；成功即删除，破坏阶段失败则保留并在
下次同 project reset 时复用，使半重建且无法健康启动的 deployment 仍可再次复位。recovery 路径可以
报告但内容与 secret 永不输出，它不是长期备份。

三卷被删除后，旧 ERP 账号、Better Auth session/Cookie、产品文件、旧 admin key 与旧 backend credential
全部永久失效。runner 不尝试保留或重新 seed 管理员；新管理员只能经浏览器 Setup 原子创建。

### 与停止、备份和恢复的边界

`bun run infra:down` 是日常停止命令，永远不带 `-v` 并保留全部数据卷。`bun reset` 是开发者明确放弃
当前本地 deployment 的破坏性动作，不能作为停机、故障修复、生产清数或恢复手段。恢复继续使用全新
目标 project 的 snapshot/import 流程；不得先 reset 原环境再把备份覆盖回来。

## 否决方案

- **直接 truncate Convex PostgreSQL 表**：Convex 与 Better Auth schema 属平台内部实现，且无法同步
  清理 S3 modules/files、deployment env 和 instance credential。
- **只执行 `docker compose down -v`**：缺少工作树归属、精确卷集合、production/remote guard、凭据
  重建、函数部署和 Setup 后置条件。
- **保留 backend credential 或旧 `.env.local` admin key**：会把新数据平面与旧控制凭据混合，并给
  操作者造成旧 key 仍可用的错误预期。
- **自动 seed 管理员**：绕过要验收的真实首用户事务，使 `/setup` 场景失真。
- **让 `--yes` 跳过安全检查**：自动化便利不能扩大可删除范围。

## 后果

- 开发者可以用一条可审计命令重复验证从空 deployment 到完整初始化的用户旅程。
- reset 的完成含义从“数据库已清空”提升为“基础设施、deployment env、functions 与公开 Setup 状态
  一致”；阶段失败必须明确报错，不能宣称 setup-ready。
- 已有快照仍可用于独立恢复演练，但旧本地登录凭据和 admin key 不随备份目录保留而继续有效。
- smoke、日常 `dev` 与 reset 应复用生成 admin key、注入 deployment env 和部署 functions 的同一实现
  seam，避免 fresh clone 与 CI 形成不同的初始化协议。

## 验证

- `bun reset --dry-run` 对 Docker 与文件系统不产生写入，并精确报告 project 与三个 volume。
- 交互 project 名不匹配、production 标识、远程 Docker 或 foreign resource 均在删除前失败。
- `bun reset --yes --no-web` 最终公开状态为 `initialized=false, hasUsers=false`，且 Web 保持未启动。
- 默认 `bun reset` 在相同状态断言后使 `/setup` 返回成功，浏览器可创建唯一首管理员并继续业务底座。
- `bun reset` 与 `bun db:reset` 使用同一 runner；`bun run infra:down` 停止后三个 volume 仍存在。

## 关联决策

- [Convex-only 应用边界](2026-08-01-convex-only-application-boundary.md)
- [自托管 Convex 平台](2026-07-31-self-hosted-convex-platform.md)
- [Better Auth 与 ERP Actor](2026-07-31-convex-auth-and-actor.md)
- [自托管 Convex 运维手册](../runbooks/convex-self-hosted.md)
