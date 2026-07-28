# 02 base 主数据 + IAM + 客商员工

Status: ready-for-agent
Blocked by: 01

## 范围

`server/src/modules/` 下落地首批业务域（四件套 meta/routes/service/test，见 `modules/README.md`）：

1. **base**：公司（新建同事务种子三仓）、货币（启停拦新不拦旧/本币保护）、计量单位（四类/基准单位/ratio>0）、会计科目（树/汇总与叶子/角色标记/删除约束）。
2. **iam**：用户、角色（授权同步/内置角色只读）、用户角色分配、公司授权（fail-closed）；权限目录端点已由骨架 meta 提供，本工单补齐管理面 CRUD 与权限矩阵规格测试。
3. **party**：客户、供应商（含编号规则接入）、员工主数据（`hr_employee`：参保类型多选/考勤机编号唯一）。
4. **供应链设置业务面**：公司默认过账科目（一公司一行四槽；校验口径同单据头科目；销售/采购 Tab 各维护本侧两槽 upsert）。

全部资源注册 Meta（权限码/Grid/打印目录自动派生）；列表走 `POST .../query` + filterbuild。

## 行为参考

`server-go/internal/domain/base/`、`server-go/internal/platform/iam/`、`server-go/internal/domain/systemops/`；语义以 `CONTEXT.md` 对应词条为准。

## 验收

- `verify-system-ops-rest.ts`、`verify-party-employee-rest.ts` 全绿（SYNIE_API_URL 指 Bun）
- 权限矩阵规格测试（通配/公司隔离/fail-closed 拒绝用例）
- 通用 DoD：bun test + tsc 绿；meta 注册；wire 形状一致

## 非目标

不做初始化向导（工单 16）；不做员工考勤/工资（工单 13）。

## Comments

- 2026-07-28 集成代理：cherry-pick 分片 e9c8d7e 栈（base 四资源 + IAM + party + 公司默认过账科目）并装配 app/index；补 market-instruments 查询面、权限矩阵规格测试、权限先于 body 校验、pr-2.10/pr-2.18 Grid 快照。`cd server && bunx tsc --noEmit` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 70 pass。`verify-party-employee-rest.ts` 对 Bun（:18081）全绿。`verify-system-ops-rest.ts` 审计 Meta/权限先校验已过，阻塞于 `/todos/*`（工单 09 待办面）。未改 server-go。
- 2026-07-28 独立验收：读代码对照 server-go/OpenAPI（wire/权限先于校验/金额 decimal/withTx/Meta/hc 链）；`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 71 pass；`verify-party-employee-rest.ts` 对 Bun:18082 全绿；base/IAM/默认过账科目 HTTP 冒烟（三仓种子、本币保护、科目角色槽、partial upsert、权限先 403）。修复 filterbuild：`fk/enum/enumArray/polyFk` 缺 `values` 时 TypeError→500，改为 validation 400 并补单测。`verify-system-ops` 仍阻塞 `/todos/*`（工单 09）。未 push/reset。
- 2026-07-28 独立验收（阶段 A 复验）：Meta 21 资源已注册；base/iam/party 路由权限中间件先于 zValidator；`bun run typecheck` 绿；全量 99 pass；`verify-party-employee-rest`（:18083）meta=6 customer/supplier/employees/enumArray/autoNumber/permissionFirst=9 audits=9 全绿。`verify-system-ops` 仍在 `POST /todos/query` 404（工单 09）。无新增缺陷。
