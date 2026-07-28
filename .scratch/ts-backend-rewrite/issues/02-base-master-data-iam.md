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
