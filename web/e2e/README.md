# 浏览器 e2e

现行验收是 **Bun/Hono 栈套件**：`playwright.api.config.ts` + 各 `*.api.e2e.ts`，覆盖登录、
Grid/Drawer 动线、文件、打印、设置等，并断言业务请求 **GraphQL=0**。认证为 JWT，
与旧 Phoenix.Token 不兼容。

## 跑法

一键（重建演示库 → SQL 迁移 → 起 Bun 后端 → 初始化向导示例路径：超管 + JT 公司 +
全业务链示例数据 + 一个空科目公司，见 `e2e/provision-demo.ts` → 起前端 → 冒烟 → 收摊）：

```bash
cd web
bunx playwright install chromium   # 首次:装浏览器
bun run e2e                        # = ./e2e/run-smoke.sh，默认 API 8090 / 前端 3011（避开开发栈 8080/3000）
```

注意：一键脚本默认**重建 compose 里的 `synie` 库**（销毁其中数据）；`KEEP_DB=1` 可跳过
重建与初始化，但要求库已迁移、已初始化且 admin 口令与 `E2E_ADMIN_PASSWORD` 一致。

对已经起好的栈跑（自己起 Bun 后端 + `bun run dev`）：

```bash
cd web
E2E_BASE_URL=http://localhost:3011 bun run e2e:api          # 全量
E2E_BASE_URL=http://localhost:3011 bun run e2e:api -- settings.api.e2e.ts   # 定向
```

超管账号默认 `admin` / `synie-integration-admin-password`，可用 `E2E_ADMIN_USERNAME` /
`E2E_ADMIN_PASSWORD` 覆盖（脚本与 spec 共用这两个变量）。

API 地址环境变量优先 `SYNIE_API_URL`（兼容旧名 `GO_API_URL`）；Vite 代理端口优先
`SYNIE_API_PORT`（兼容 `GO_API_PORT`）。

## 遗留 authz 冒烟（冻结）

`playwright.config.ts` + `authz-smoke.e2e.ts` / `trading-company-column.e2e.ts` +
`global-setup.ts` 是 Elixir 时代的权限薄冒烟，依赖 `backend/` 演示库与 GraphQL 管理
动线，Go-only 切流后不再维护，随 `backend/` 删除一并清理。API 层权限覆盖率由
Bun 服务端测试与各 `*.api.e2e.ts` 接管。

## nightly 化（后议）

当前为本地/按需跑。若要 nightly：把 `run-smoke.sh` 挂到定时 job（独立于 PR CI），
产物收 `playwright-report/`。先解决脆性来源（HeroUI token 注入、演示库幂等重建）再上，
本节留作复议决策。
