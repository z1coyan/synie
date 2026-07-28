# 17 web 切 hono/client + Resource Client 改造

Status: ready-for-human
Blocked by: 06, 07, 08, 09, 10, 11, 12, 13, 14, 15

## 范围

1. **传输层替换**：`web/app/lib/api/` 由 openapi-fetch + schema.d.ts（openapi-typescript 生成）整体替换为 `@synie/server` 的 `ApiType` + `createApiClient`（hono/client）；删除 `bun run openapi` 脚本与 schema.d.ts 生成物。
2. **Resource Client 适配**：`createResourceClient` 的 list/query/get/create/update/delete/command 全部改走 hc；FilterState 序列化复用 `@synie/shared`；错误 envelope 解析对齐统一错误模型（fields 进表单）。
3. **类型收敛**：web 侧 `synie-data-grid/types.ts` 的 wire 类型改为 re-export `@synie/shared`（单一事实源），页面 import 不动。
4. **e2e**：Playwright 配置改打 Bun server（8081→8080 切流后统一）；`web/e2e/*.go.e2e.ts` 更名泛化。
5. server 端补 `src/client.ts` 导出路径（package.json exports），必要时给 web 提供 token 注入约定。

## 行为参考

`web/app/lib/resources/`、`web/app/components/synie-data-grid/`；`server/src/client.ts`。

## 验收

- `bun run check` + `bunx tsc --noEmit` + `bun test`（web）全绿
- Playwright 关键路径 e2e（登录/主数据 CRUD/一条销售链/权限拒绝）全绿
- 全仓 grep：无 openapi-fetch / openapi-typescript / schema.d.ts 残留

## 非目标

不改 UI 设计与页面结构（纯传输层与类型源切换）。

## Comments

- 2026-07-28: 验收补完 — web `bun test` 92/0、`bun run check` ok；server 最小 setup 端点落地；`scripts/verify-web-hc-api.ts` 关键路径 API 绿（登录/主数据 CRUD/销售报价→订单/401）。Playwright UI 本环境缺 HeroUI Pro 鉴权安装（`@heroui-pro/react` 无 dist entry），浏览器 e2e 待 token 环境再跑 `run-smoke.sh`。
