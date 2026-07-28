# 02 base 主数据 + IAM + 客商员工

Status: ready-for-human
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
- 2026-07-28 隔离 worktree 复验（grok-4.5）：Meta 已含 basCompanies/Currencies/Units/Accounts、sysUsers/Roles、salCustomers/purSuppliers/hrEmployees、salCompanyAccountDefaults 等；IAM 权限中间件先于 zValidator；权限矩阵规格 8 项 + base/iam/party 集成绿。活 API PORT=18092：`verify-party-employee-rest` meta=6 customer=1 supplier=1 employees=6 enumArray=2 autoNumber=3 permissionFirst=9 audits=9 全绿（测试库需 00003 行情目录种子以覆盖 WEIGHT/EXCHANGE enum 回归）。`verify-system-ops` 仍阻塞 todos（工单 09，非本工单范围）。无代码变更；未改 server-go；未 push。
- 2026-07-28 补 remaining：todos 已挂载且可用；活 API :18093 `verify-system-ops-rest` 全绿（meta=2 unavailableMeta=6 permissionFirst=7 readOnly=12 auditScope=6 todoBehavior=7 todoState=9 internalInvariants=3）；`verify-party-employee-rest` 全绿。新增 `company-account-default.integration.test.ts`（空壳 getByCompany/角色槽校验/他司科目拒绝/partial upsert/权限 fail-closed/Meta）。相关 suite 120 pass。验收项闭环。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
