# ADR：Better Auth 认证与 ERP Actor 授权分层

2026-07-31，状态：已实施；2026-08-01 已完成全部业务切流并移除临时双模式。本 ADR 固定身份、
授权内核和首用户原子初始化；最终应用边界见
[`2026-08-01-convex-only-application-boundary.md`](2026-08-01-convex-only-application-boundary.md)。

## 背景

旧服务以浏览器 `localStorage` 中的 HS256 JWT 标识用户，再由 Bun/Hono 每次请求读取用户、启用
角色、角色权限和公司授权来组装 Actor。后端迁到 Convex 后仍需保留「认证只回答是谁，ERP
授权每次调用实时计算」的边界，不能把权限或公司范围固化进长寿命 token。

项目没有业务邮箱字段，用户仍必须使用 1..64 个 Unicode 字符的用户名登录，且大小写不敏感。
公开注册、邮箱登录、OAuth、2FA 与用户自助改密不在本阶段范围。

## 决策

### Better Auth 只管理 principal 与 session

自托管 deployment 固定以下兼容版本，并作为一组升级与回归：

- `convex@1.42.3`
- `@convex-dev/better-auth@0.12.5`
- `better-auth@1.6.25`
- `@convex-dev/react-query@0.1.0`

Better Auth component 保存认证 principal、credential 与 session；应用表 `appUsers` 保存 ERP 用户，
通过唯一 `authUserId` 与 principal 相连。浏览器只访问 TanStack Start 同源 `/api/auth/*`，session
使用 HttpOnly、SameSite=Lax cookie。`SITE_URL` 为 HTTPS 时强制 Secure；本地 loopback HTTP 才允许
非 Secure cookie。部署只信任 `SITE_URL` origin，反向代理必须传递转发后的 host/proto/origin。

Convex deployment secret 只用 `convex env set` 注入：

- `SITE_URL`：浏览器访问应用的公开 origin；
- `BETTER_AUTH_SECRET`：Better Auth session secret；
- `SYNIE_AUTH_SPIKE_SECRET`：仅隔离 smoke 临时使用，测试结束立即移除。

应用构建环境分别使用 `VITE_CONVEX_URL`（Convex WebSocket/API）、`VITE_CONVEX_SITE_URL`（公开
HTTP action site）和 `VITE_SITE_URL`（应用公开 origin）。容器内的 `CONVEX_SITE_ORIGIN` 必须指向
`http://convex-backend:3211`，不得把宿主机地址写入 backend；浏览器公开 site URL 单独配置。
代码不得硬编码 `convex.cloud` 或 `convex.site`。

### 用户名保持业务语义，内部 email 永不成为业务字段

用户名先 trim，再以稳定 lowercase key 做唯一约束；显示值保留原始大小写，校验为 1..64 个非空
Unicode code point。登录失败统一为「用户名或密码错误」，禁用用户名可用性端点与 email 登录。

Better Auth adapter 仍要求 email，因此受信任的用户创建 mutation 生成随机
`<随机值>@internal.syn.ie`。该值不由用户名推导，不进入 `appUsers`、Resource Catalog、搜索、日志、
审计或 UI；登录与 session response 在认证边界删除整个 `email` 字段。公开 signup 始终拒绝。

登录防暴破以「客户端 IP + 规范化用户名」为 key，原子记录 5 分钟窗口内的失败次数：前 10 次
仍返回统一凭证错误，第 11 次及窗口内后续请求返回限流，成功登录清零。Better Auth 的通用请求
限流只保留为更高的滥用上限，不能抢先改变这条业务规则。

### Actor 是全部业务函数的授权边界

每次公开业务调用按认证 principal 查 `appUsers`，再读取当前启用角色、角色权限与公司授权，生成
Actor。未知/停用用户、停用角色、缺少权限与无公司授权一律 fail-closed；超级管理员和全公司旗标
保持既有语义。角色或公司授权 mutation 提交后，下一次函数调用立即生效，无需重新登录。

公开函数使用统一 `authed*` / `permissioned*` wrapper。action 可以读取授权快照来执行外部 I/O，
但最终写入的 internal mutation 必须重新鉴权，不接受客户端或 action 回传的 permission list。
架构测试阻止新增裸 `query()` / `mutation()` 绕过包装器，只有认证 HTTP 与明确的初始化入口列白名单。

### 初始化与用户管理跨 component/application 表保持原子

首用户 mutation 在同一 Convex transaction 中创建 Better Auth principal、credential、ERP 超级管理员
与初始化状态；20 个并发请求只能一个成功。四个阶段的故障注入均证明整笔回滚，不会留下「能登录
但无 Actor」或「有 Actor 但无凭证」的半状态。若发现已有 ERP 用户但缺初始化标记，UI 关闭创建
表单并提示运维恢复，禁止覆盖已有账号。

管理员创建用户和重置密码只返回一次性随机密码；重置密码会撤销该用户所有既有 session，删除用户
会在同一 mutation 删除认证 principal、授权关系和 ERP 用户。认证库不接管 ERP 角色或公司模型。

### 迁移模式已经退役

2026-08-01 清场后，运行时只有 Convex generated API/ResourceBinding；迁移期的进程模式、旧认证与
业务 REST transport 已删除。页面和事务没有 fallback 或 token bridge，架构门禁阻止这些入口重新出现。

Convex React client 不启用 `expectAuth`：该选项会在没有 token 时暂停所有请求，使公开的首用户
mutation 无法执行。客户端连接状态不是安全边界，身份与权限仍全部在函数端强制校验。

## 否决方案

- **把权限/公司范围放入 session JWT**：授权变更无法即时生效，也扩大被盗 token 的能力窗口。
- **使用 Better Auth organization/admin 代替 ERP 公司和角色**：认证库模型不等于业务授权模型。
- **要求业务用户提供 email**：改变现有登录体验并产生不存在的业务主数据。
- **公开 signup 或用户名枚举**：企业内部账号必须由初始化或受权限保护的管理员入口创建。
- **让 legacy API 接受 Better Auth token**：会形成跨后端事务和长期兼容层。

## 验证证据

- 全新隔离 self-hosted stack 完成 component deploy、4 个故障点回滚、20 并发首用户竞争、公开注册
  拒绝、用户名登录、统一错误、10/5 分钟限流、内部 email 脱敏、SSR token、退出与 session 撤销。
- 同一 session 下角色权限、公司授权和角色停用立即生效；密码重置与用户删除立即撤销旧 session。
- backend/dashboard 重启后既有 session 与 Actor 可恢复。
- 真实 Chromium 通过完整 setup → 自动登录 → SSR 刷新 → 业务资源闭环 → 退出 → 大小写不敏感
  重登；浏览器业务请求只走 Convex，cookie 为 HttpOnly/SameSite=Lax。
- `test:self-hosted-auth` 在 CI 每次以新 Compose project/volume 验证，测试结束只停止容器并保留卷。

## 后果

- 认证 schema 与 ERP 授权 schema 独立演进，但 principal/app user 关联必须作为一致性约束维护。
- 升级四个固定依赖中的任一个，都必须成组核对兼容矩阵并重跑真实 self-host smoke，不能只依赖类型检查。
- 完整初始化向导、权限目录和业务用户界面均已落在 Convex，后续演进不得绕开本 ADR 的 principal、
  Actor、session 与原子写入边界。
