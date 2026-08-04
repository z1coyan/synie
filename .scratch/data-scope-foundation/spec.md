# Spec: 数据范围阶梯与部门主数据（行级权限地基）

**Status:** ready-for-agent
**Feature slug:** `data-scope-foundation`
**ADR:** [docs/adr/2026-08-04-data-scope-ladder-and-department.md](../../docs/adr/2026-08-04-data-scope-ladder-and-department.md)
**Domain terms:** 权限码、权限目录、内置角色、菜单权限（见 `CONTEXT.md`）；新增「部门」「数据范围阶梯」（本规格定义，落地时同步进 `CONTEXT.md`）
**Depends on:** IAM 角色/权限体系（已交付）、公司数据范围闸门（`companyScopeWhere`，已交付）、菜单白名单设施（已交付）

---

## Problem Statement

履约需求单即将引入「委派」：计划员把需求行委派给车间（金具/冲压）或采购人员，且**委派给采购的需求单对其他采购员、车间不可见**（仅委派人/计划与被指派人可见）。现状权限体系只有扁平权限码 + 公司级数据范围，**没有任何记录级可见性机制**；系统也没有任何组织实体可承载「冲压车间」这样的指派对象。若按资源散写行级过滤 SQL，每扩展一个表就重复一遍，未来引入部门等维度后后端将不可收拾。定案：业务改造暂停，先把行级权限地基打好——**范围策略注册表**（收口机制）+ **数据范围三档阶梯**（权限码约定）+ **部门主数据**（组织载体）。

## Solution

1. **范围策略注册表**（`platform/authz/scope.ts`）：策略 = 纯函数 `(actor) => WHERE 片段`，按资源注册、按维度 AND 组合。现有公司范围闸门迁入成为第一个维度；列表统一经 `listFromSource.extraWhere` 走注册表，单条读取统一经 `requireRowAccess`（fail-closed = not_found）。业务 service 只调闸门、不拼规则。
2. **数据范围三档阶梯**：读权限拆为 `read`（参与人）/ `read_dept`（部门及下级）/ `read_all`（全范围），判定取已授予中最宽档，通配蕴含 `read_all`。`read` 重定义为最窄档，但**按资源逐个生效**——未注册阶梯策略的资源行为不变；本期无资源接入。
3. **部门主数据**：`sys_department` 树（code 唯一 + name + `parent_id`，保存防环），`sys_user.department_id` 可空单列；「部门」范围恒含下级；无部门用户退化为参与人范围；有下级或有成员的部门禁删；系统管理新增部门维护页，用户表单挂部门。

本期交付后**业务行为零变化**，价值全部埋在机制与约定里，由随后的需求单委派改造收割。

## User Stories

1. As a 系统管理员, I want 在系统管理下维护部门树（新增/改名/调整上级/删除）, so that 组织架构有唯一事实源
2. As a 系统管理员, I want 保存部门时把上级设成自己的后代被拒绝, so that 部门树不成环
3. As a 系统管理员, I want 删除有下级或有成员的部门被拒绝并说明原因, so that 不挂出孤儿节点与悬空引用
4. As a 系统管理员, I want 在用户表单给用户挂部门（可空、单选、树形选择）, so that 数据范围判定有所依据
5. As a 系统管理员, I want 部门维护由独立权限码 `sys.department:*` 门控, so that 组织维护可与用户管理分人
6. As a 用户表单操作者, I want 部门选项在用户管理权限下可读（不必持部门维护权限）, so that 挂部门不被权限鸡生蛋卡住
7. As a 后端开发者, I want 任何资源注册行级策略只改注册表一处、业务查询只调统一闸门, so that 新维度（区域/产品线）不动业务代码
8. As a 后端开发者, I want 公司范围改走注册表后全部现有测试不加改动通过, so that 这次收口是行为不变的纯重构
9. As a 后端开发者, I want 单条读取经 `requireRowAccess` 不可见时按 not_found 处理, so that 不泄露记录存在性（对齐公司闸门口径）
10. As a 角色配置者, I want 资源接入阶梯后按 `read`/`read_dept`/`read_all` 三码授权、高档蕴含低档, so that 配置界面保持勾码形态、不引入条件表达式
11. As a 系统, I want 范围判定取已授予码中最宽档且通配蕴含 `read_all`, so that 与现有 `candidates()` 通配语义兼容
12. As a 系统, I want 无部门用户的部门范围退化为参与人范围, so that 组织数据缺失时向安全方向收敛
13. As a 审计要求方, I want 部门与用户部门归属的变更留审计痕迹, so that 谁把谁挂进了哪个部门可查

## Implementation Decisions

### 语义规约（grill 定案）

- **数据范围阶梯**（新术语）：读权限的三档记录级范围——**参与人范围**（`read`：我创建的、或指派/委派给我的）、**部门范围**（`read_dept`：我所在部门及所有下级部门成员的）、**全范围**（`read_all`：公司内不受限，即现状语义）。判定取已授予码中**最宽一档**；`资源:*` / `域.*` / `*` 蕴含 `read_all`。
- **条件永远留在领域数据**：可见性条件（类型、车间、指派对象……）是业务动作产生的普通数据，由策略函数翻译成 SQL；权限语言保持扁平码，不引入条件表达式（拒绝 ABAC DSL 与码内嵌条件）。
- **按资源逐个生效**：阶梯是语义约定；资源未注册阶梯策略时 `:read` 行为与现状一致。资源目录支持为读动作声明「接入阶梯」并派生三码；本期无资源声明。
- **部门**（新术语，`sys_department`）：组织树主数据——code 全局唯一（手填，不挂编号规则）+ name + `parent_id` 可空自引用；保存校验不成环（沿祖先链检测）；「部门」范围语义**恒含下级**（递归 CTE 取子树 id 集）；有下级或有成员的部门**禁止删除**；本期不做停用。
- **部门挂用户**：`sys_user.department_id` 可空单列（一人单一部门）；无部门用户的 `read_dept` 退化为参与人范围；用户↔员工档案（`hr_employees`）打通**后置**，本期不动。

### 数据模型

- 新表 **`sys_department`**：`id` uuid 主键；`code` text 非空全局唯一；`name` text 非空；`parent_id` uuid 可空自引用；`inserted_at`/`updated_at` 对齐基线表惯例。
- **`sys_user` 加列** `department_id` uuid 可空引用 `sys_department`（不挂级联删除；删部门前置校验有成员则拒）。
- 迁移只建表加列不写行（对齐「老环境不强塞」先例；当前未上线，`db:reset` 即可）。

### 后端

- **`platform/authz/scope.ts`（新建）**：范围策略注册表——
  - 策略接口：`type ScopePolicy = (actor: Actor) => RawBuilder<unknown> | null`（null = 不约束）；资源可注册多个维度，输出片段 **AND 组合**；
  - `scopeWhere(actor, resource): { empty: boolean; where: RawBuilder | null }`：聚合某资源全部维度（公司维度恒在内），语义对齐 `companyScopeWhere`（empty 时调用方直接返回空列表/not_found）；
  - `requireRowAccess(actor, resource, row)`：单条读取闸门，fail-closed 按 not_found，对齐 `requireCompanyAccess` 先例；
  - **公司维度迁入**：`listFromSource` 调用点统一改走注册表（`db/list.ts` 的 `companyScopeWhere` 保留为注册表内部实现或薄封装）；本次改道为行为不变纯重构。
- **Actor 扩展**：会话装载带 `department_id`；部门子树 id 集由策略内递归 CTE 现查（部门表极小，不建闭包表）。
- **阶梯判定**：`resolveReadScope(actor, resource): 'participant' | 'dept' | 'all'`——取已授予码最宽档（`read_all` / `read_dept` / `read`），通配经 `candidates()` 命中 `read_all` 即全范围；资源目录的读动作声明支持 `rowScope: 'ladder'` 并派生 `read`/`read_dept`/`read_all` 三码（本期无资源声明，目录内容不变）。
- **部门服务**（IAM 域）：CRUD + 树查询；保存防环；删除前置校验（有下级/有成员则拒并说明）；审计走 `writeAudit` 先例（资源名 `sys_department`；用户部门归属变更并入用户审计）。路由 `GET/POST /system/departments`、`PUT/DELETE /system/departments/:id` + 树形选项接口，权限门控 `sys.department:*`；**用户表单用的部门选项接口挂 `sys.user:read`**（消费方权限开口子，对齐采购订单需求单勾选池先例）。
- **资源注册**：新增 `sys.department`（中文标签「部门」，动作 create/read/update/delete），随权限目录派生进入角色权限矩阵；前端 `permission-labels.ts` 补标签。
- **内置角色**：admin 通配不变；`sales` 不授 `sys.department`；阶梯 `read_all` 补授**跟随第一个接入阶梯的资源**（需求单改造）同窗完成，本期无种子变更。

### 前端

- **部门页**：系统管理新增「部门」（`menu.system.departments`，前端菜单声明 + 后端菜单目录同步，契约测试对拍）——树形列表 + 抽屉表单（code/name/上级部门树选择）；删除被拒时展示后端原因。
- **用户表单**：加「部门」字段（树形单选、可清空）；用户列表加部门列。
- **菜单/权限标签**：菜单声明补 code 与标签；权限标签补 `sys.department`。

## Testing Decisions

好测试的标准：只测外部行为（API 契约、范围判定结果、SQL 片段语义），不断言内部结构；纯重构由现有测试网原样兜底。

- **接缝 1 — 部门服务 PG 集成测试**（对标 `iam.integration.test.ts`）：CRUD 往返；code 唯一冲突；防环（直挂后代/间接成环均拒）；有下级/有成员删除被拒；审计留痕；端点权限门控（无 `sys.department:*` 被拒）。
- **接缝 2 — 范围注册表单测**（纯函数/SQL 片段）：多维度 AND 组合；空约束直通；公司维度与现状 `companyScopeWhere` 输出等价（迁移等价性）。
- **接缝 3 — 阶梯判定单测**：`resolveReadScope` 最宽档优先（仅 `read`→参与人；`read_dept`→部门；`read_all` 或 `资源:*`/`*`→全范围）；无部门用户 `read_dept` 退化参与人。
- **接缝 4 — 目录派生契约测试**：声明 `rowScope: 'ladder'` 的**测试夹具资源**派生三码且标签齐全；未声明资源目录不变（证明本期零行为变化）。
- **回归**：现有公司隔离相关集成测试**不加改动全部通过**（行为不变重构的判定标准）；菜单目录契约测试纳入 `menu.system.departments`。
- **UI/浏览器层不强制**（薄可视层先例）。

## Out of Scope

- **任何业务资源接入阶梯**（含履约需求单委派改造——行级委派、单级可见性派生、委派目标形态，随后单独立项，是本设施第一个真消费者）
- 用户↔员工档案打通；车间工人账号化
- 部门停用/启停状态机；多部门成员表（一人多部门）
- 「仅本部门（不含下级）」第四档；用户级数据范围覆盖（只挂角色授权）
- 规则引擎/界面自助配置数据权限（策略即代码是本期定案；演进只换注册表实现，不动调用点）
- Postgres RLS

## Further Notes

- 本规格来自 2026-08-04 grill 定案（收口注册表、条件留数据、三档阶梯、`read` 重定义按资源逐个生效、部门成树恒含下级、单一部门可空退化、未上线不写迁移、不接业务资源），实现以 ADR + 本 spec 为准。
- 实现落地时按 AGENTS.md 同步：`CONTEXT.md` 新增「部门」「数据范围阶梯（参与人/部门/全范围）」词条，并更新「菜单权限」词条中「行级权限保留给将来」的指向（将来=本设施）；`docs/产品文档/` 系统管理相关篇补部门维护说明。
- 扩展点：需求单委派改造时，委派记录（需求行→部门/人）作为领域数据，需求单资源声明 `rowScope: 'ladder'` 并注册参与人策略（我创建的 OR 存在委派给我的行），同时补授计划/管理角色 `read_all`——全部落在本规格机制内，无新增架构决定。
