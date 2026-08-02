# 05 — SSR 鉴权与 Query 脱水摊牌（后续）

**What to build:** 在**明确的产品/安全取舍**后，让需鉴权的 loader 在 SSR 阶段也能
安全取数并脱水到客户端，消灭「SSR 空壳 + 客户端再拉」的双重成本（若产品需要）。

**Blocked by:** 01, 02；可能依赖认证模型改造（cookie / Start server functions 等）

**Status:** ready-for-agent

**Parent:** [.scratch/route-loader-prefetch/spec.md](../spec.md)

## 背景

当前 token 在 `localStorage`，API 为相对路径；`_app` beforeLoad 与
`ensureDefaultGridPage` 均在 `typeof window === 'undefined'` 时跳过。
ADR 已记录：本轮有意保持 SSR 空壳。

## 改动面（示意，实施前需独立设计评审）

- 凭证如何到达 SSR（HttpOnly cookie 优先于把 JWT 塞进可序列化 context）
- 服务端请求的绝对 base URL 与 cookie 转发
- `getAppQueryClient` 的 per-request 生命周期与
  `setupRouterSsrQueryIntegration` 脱水/注水
- 移除或收窄 route-prefetch 的 window 守卫
- 不得削弱认证门；login/setup 流程保持正确

## 验收标准

- [ ] 书面 ADR 修订：SSR 鉴权方案、威胁模型、与 SPA 回退兼容
- [ ] 至少 1 个试点路由 SSR HTML/dehydrated state 含业务列表数据
- [ ] 无 token 时行为与现网一致（重定向登录/setup）
- [ ] 客户端 hydrate 不重复打首屏全量列表（或仅 stale 再验证可接受）
- [ ] 安全：token 不进可被第三方脚本轻易读取的新通道（相对 localStorage 不劣化）
