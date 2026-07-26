# PR-2.10 客户、供应商、员工迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，不改变业务规则；权威运行参考仍是迁移前
Elixir Resource、真实 `GridMeta.build/2` 输出与既有产品/ADR。

## 范围与来源

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `salCustomers` | `SynieCore.Sales.Customer` | `sal_customers` | `sales.customer` |
| `purSuppliers` | `SynieCore.Purchase.Supplier` | `pur_supplier` | `purchase.supplier` |
| `hrEmployees` | `SynieCore.Hr.Employee` | `hr_employees` | `hr.employee` |

主要来源：

- `backend/apps/synie_core/lib/synie_core/sales/customer.ex`
- `backend/apps/synie_core/lib/synie_core/purchase/supplier.ex`
- `backend/apps/synie_core/lib/synie_core/hr/employee.ex`
- `backend/apps/synie_web/lib/synie_web/grid_meta.ex`
- `docs/产品文档/基础资料.md`
- `docs/产品文档/人力薪酬.md`
- `docs/adr/2026-07-18-material-customer.md`
- `docs/adr/2026-07-18-employee-insurance-types.md`

## 真实 GridMeta 快照

运行：

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_party_employee_contract.exs \
  ../.scratch/migration/snapshots/pr-2.10
```

脚本生成 superadmin 与仅持三个资源 read 权限的 Actor 快照，共六份：

- `salCustomers.superadmin.grid.json`
- `salCustomers.read-only.grid.json`
- `purSuppliers.superadmin.grid.json`
- `purSuppliers.read-only.grid.json`
- `hrEmployees.superadmin.grid.json`
- `hrEmployees.read-only.grid.json`

三个资源的 superadmin capability 均为 `create/update/delete`，read-only Actor 均为空数组。
这里的空数组不是“不可读”：`read` 是取得 Meta/查询资源的前置权限，不是写按钮 capability。
三个资源均无扩展动作，旧删除 mutation 分别为 `destroySalCustomer`、
`destroyPurSupplier`、`destroyHrEmployee`。

### 客户 / 供应商字段

两者列形状相同：

| API 字段 | 类型 | 规则 |
|---|---|---|
| `id` | string | 只读，不能筛选 |
| `code` | string | 必填，最多 32 字符，全局唯一，可修改 |
| `name` | string | 必填；客户/供应商最多 128 字符 |
| `shortName` | string | 可空，最多 64 字符 |
| `insertedAt` / `updatedAt` | datetime | 只读 |

迁移后的 Go Form 应接管旧页面 override：排除 `id/insertedAt/updatedAt`；客户 placeholder
为 `如 C0001/客户全称/如 华为`，供应商为 `如 S0001/供应商全称/如 富士康`。

### 员工字段

| API 字段 | 类型 | 规则 |
|---|---|---|
| `id` | string | 只读，不能筛选 |
| `code` | string | 最终非空、最多 32 字符、全局唯一；创建输入允许留空自动取号 |
| `name` | string | 必填，最多 64 字符 |
| `attendanceNo` | string | 可空，最多 64 字符，非空全局唯一 |
| `idNumber` | string | 可空，最多 32 字符，非空全局唯一；业务 API 可见，审计值必须过滤 |
| `householdRegistration` | string | 可空，最多 128 字符 |
| `phone` | string | 可空，最多 32 字符 |
| `currentAddress` | string | 可空，最多 255 字符 |
| `dailyWage` | decimal | 可空，不得小于 0 |
| `monthlyAllowance` | decimal | 可空，不得小于 0 |
| `insuranceTypes` | enumArray | 非空数组，默认 `[]`，可筛不可排序 |
| `insertedAt` / `updatedAt` | datetime | 只读 |

`insuranceTypes` 的八个值及顺序固定为：

1. `SOCIAL_INJURY`（社保工伤）
2. `SOCIAL_UNEMPLOYMENT`（社保失业）
3. `SOCIAL_MEDICAL`（社保医疗）
4. `SOCIAL_PENSION`（社保养老）
5. `SOCIAL_MATERNITY`（社保生育）
6. `HOUSING_FUND`（公积金）
7. `COMMERCIAL_INJURY`（商保工伤）
8. `COMMERCIAL_MEDICAL`（商保医疗）

筛选语义：

- `hasAny`：数组与所选险种有任一交集。
- `notHas`：数组不包含任何所选险种；空数组必须命中。

迁移后的 Go Form 只需下发服务端特有 override：排除 `id/insertedAt/updatedAt`，
`code` 的 placeholder 是“留空自动编号”且 **不得标 required**，`name` 标 required。
完整字段与基础布局仍由 13 个 Grid columns 生成，再与前端既有 `drawerConfig` 合并；
验收以实际渲染和提交所有员工字段为准，不要求 Go Meta 机械复制前端 registry 全布局。

旧公开 GraphQL 的 `CreateHrEmployeeInput.code` 是 `String!`：missing/null 在 GraphQL
schema 校验层直接拒绝，只有 `""` 与纯空格能进入 Ash；Ash 再将空白归一为 `nil`，
无启用规则时报“未配置启用的编号规则”，有规则时自动取号。新 REST 将
missing/null/空白统一解释为“留空”，这是 transport 层归一化，产品“留空自动编号”
业务语义不变，**不得声称三态与旧 GraphQL 等价**；手工非空编号仍原样保留。
上述 schema 与有/无规则 mutation 结果固化在 `snapshots/pr-2.10/hrEmployees.code-input.graphql.json`；
捕获脚本在同一数据库事务内临时禁用真实规则并最终显式回滚，测试规则、员工、计数器和审计均不落库。

## 删除与引用边界

- 客户：存在 `inv_material.customer_id` 引用时明确拒绝，旧错误为
  `存在关联物料,不能删除`；无物料引用时物理删除。
- 供应商：Resource 无业务引用检查，物理删除。既有对手引用多为类型 + UUID 多态裸引用，
  删除后历史名称可能无法解析。
- 员工：Resource 无额外业务校验，但考勤、工资、借款、报销等真实外键引用会阻止物理删除。

`docs/产品文档/基础资料.md` 原“客商均不做引用检查”与旧运行行为及
`2026-07-18-material-customer.md` 冲突；本 PR 已最小纠正为：

> 删除均为物理删除。客户被客户物料引用时禁止删除；供应商以及客户的其他多态往来引用
> 当前不做引用检查，删除后历史单据上的对手名称可能无法显示（应收应付报表按“未指定对手”
> 兜底），删除前需自行确认无往来数据。

`CONTEXT.md` 已有“对手”“客户物料”“参保类型”等关联词，但没有“客商”和“员工”的独立
唯一定义。若本 PR 同步补齐术语，建议最小增加：

- **客商**：供应商与客户的合称；两者均为全局主数据、分别维护且编号各自唯一。
- **员工**（Employee，`hr_employees`）：全局主数据（不挂公司），持考勤机编号、身份信息、
  薪酬标准与参保类型；身份证号是敏感审计字段。

## 验收资产

`.scratch/migration/verify-party-employee-rest.ts` 覆盖：

- 六份 Meta 逐 JSON 语义对拍与三份 Go Form 服务端 override 精确契约；
- 三资源查询、搜索、创建、更新、删除、必填、长度/枚举、唯一约束；
- 真实只读角色/用户：Meta 与 query 可读、capability 空；三资源 create/update 的畸形 JSON
  均先返回 403，delete 同样拒绝；
- 客户物料引用删除冲突，员工考勤事实引用删除冲突；
- 员工日薪/月补贴小数与清空、八险种返回、`hasAny/notHas`；
- 员工 REST `code` missing/null/空串归一化后的无规则失败与有规则 `001..003`
  自动取号，并以独立旧 GraphQL 探针记录 `String!` transport 差异；
- `idNumber` 创建、更新、删除审计分别只出现 `[FILTERED]`，明文不进入审计；
- 已迁移普通 enum（`basUnits.unitType=WEIGHT`、
  `basMarketInstruments.sourceType=EXCHANGE`）回归，防止只修 enumArray 大小写；
- 成功和异常路径均按记录 UUID 精确删除资源、IAM/编号夹具与审计，末尾断言测试数据为 0。

`web/e2e/party-employee.go.e2e.ts` 覆盖三个页面的 Grid/Drawer 创建、编辑、删除，员工薪酬
NumberField 的 number → decimal string 写入与 null 清空、参保多选/筛选；记录页面会话所有
`/graphql` 请求并断言为 0，同时核对 REST 请求清单。finally 通过同一 REST 删除遗留记录，
再按本次 UUID 精确清除审计并断言三表与审计归零。
