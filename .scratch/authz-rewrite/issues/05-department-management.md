# 05 — 部门管理与用户挂部门

**What to build:** IAM 侧组织地基：部门资源（`sys.department`，公司域、树形，对齐物料分类树页先例——DataGrid tree 懒加载）+ 用户表单挂部门（单选，RemoteSelect 限已授权公司的部门）+ 既有菜单占位 `menu.system.depts` 落真页。部门 CRUD 走新权限体系（本资源即可作为 guard/loadAuthorized 的首个消费者之一）。启用/停用独立行动作（对齐 status-toggle 惯例）；停用部门不可再挂用户，存量挂接保留但提示。

**Blocked by:** 02, 04

**Status:** done

- [x] sys_department ResourceMeta（authz: company + tree）、注册四处接入点、权限码 sys.department
- [x] 树页（参照科目表/物料分类先例）+ 抽屉表单；path 物化维护（移动节点重算子树）
- [x] 用户表单加部门字段；IAM 硬校验两条（见 02）在 UI 侧给出明确报错文案
- [x] 用户列表/详情展示部门列
- [x] 产品文档：系统管理篇补部门管理节

## Comments

**实施落点（提交见分支 `feat/authz-predicate-kernel`）**

- 后端：`modules/iam/meta.ts` 的 `departmentResourceMeta()`（`authz: { kind: 'company' }`，权限码 `sys.department`）、
  `modules/iam/department-service.ts`（Permit 化服务）、`modules/iam/routes.ts` 的 `iamDepartmentRoutes`
  （每端点挂 `guard('sysDepartments', 动作)`，handler `permitOf(c)`）、`app.ts` 挂 `/system/departments`。
- 前端：`lib/resources/iam.ts` 的 `departmentClient` + registry 一行、`routes/_app/system/depts.tsx`
  （顶部公司选择器 + 树形 DataGrid + RecordDrawer + 启停行动作，对齐科目表先例）、
  `menu.ts` 的 depts 项去掉 TODO 并补 `relatedPermissions: ['sys.department']`。
- 用户侧：user meta 加 `departmentId` fk 字段；`listUsers` 投影补列；create/update 路由与 DTO 打通；
  部门候选按「表单已选公司 ∩ 未停用」过滤。
- 测试：`modules/iam/department.postgres.test.ts`（18 例：路径物化/移动子树/成环/公司边界/启停/删除守卫/审计）、
  `test/department-http.integration.test.ts`（6 例：401 / 403 码不满足 / 404 跨公司，逐动作码门控）。

**顺带补的平台缺口（本工单发现，属工单 04 的执行面遗漏）**

- `Registry.authzTarget(name)`：判定归宿解析 + seal 后记忆化的**唯一**入口；`AuthzEnforcer.targetOf`
  改为委托它，服务层（`listAuthorized`/`loadAuthorized`）与 guard 从此共用同一份解析结果。
- `db/load.ts` 新增 `loadAuthorizedFrom` / `findAuthorizedFrom`：按 Permit 从**投影 SOURCE**（带 join 的子查询）
  取单行。原 `loadAuthorized` 只支持裸表，而各模块 `get` 普遍要 join 出 fk 名称——扫荡期 09-12 都需要这个。
  行锁仍走 `loadAuthorized({ forUpdate: true })`（子查询不能加 FOR UPDATE）。

**评审（/code-review 两轴）后补的修复**

- 用户列表/详情的部门列原来印 uuid 前缀：fk 列靠 `row.department` 取名字，`listUsers`/`getUser`
  未 join 部门名。已补投影（列表走子查询、单条 leftJoin）与 `IamUser.department`，并加回归用例。
- 服务端字段级校验原来到不了用户眼前（抽屉只 toast envelope 顶层「用户参数不合法」）。
  已在 `SynieRecordDrawer` 里收口：提交异常带 `fields` 就近展示在字段下方 + 文案进 toast description，
  **全站页面同时受益**（不是逐页 plumbing）。
- `statusToggleActions` 加可选 `hint`：部门停用时提示「已挂接的用户保留不变」（工单原文的「但提示」）。
- 部门树的 advisory lock 由表级改为**按公司**（`sys_department:<companyId>`），公司间写入不再互相阻塞。
- 文档两处过度声明已改回事实：矩阵不展示 `grants_all`（前端未投影该旗标）、
  部门子树变更受 Actor 缓存 30s TTL 约束（不是「立即」）。

**UI 冒烟（真机浏览器，独立 4111/3111 一对服务，用后即停、dev 数据已清）**

建根/建子/树懒加载展开/停用持久化/删除被 409 拦/用户表单选部门→列表显示部门名，逐条通过。
过程中抓到一个单测与 typecheck 都看不见的真 bug：部门 transport 抄了 user/role 的
`strictListLabel: 'IAM'`，而严格模式**拒收 fixedFilter**，树页按公司收窄直接 fail-closed
（页面报「IAM REST 资源不支持 fixedFilter」）。已去掉严格标记。

**留给后续的重复（有意不在本工单动）**

- 公司域树页脚手架（公司选择器 + 默认首家 + reloadKey + 「请先选择公司」空态）在
  `base/accounts.tsx` 与本页重复第三次，值得抽 `useCompanyScope()` + 共享 picker（会动到存量页）。
- `resolveParent` 的父级校验级联与 `inventory/category-service.ts`、`base/account-service.ts`
  同形；三者领域规则各异（is_leaf / 公司 / 停用），抽公共树 helper 应连同扫荡期一起做。

**坑**

- `substring(path FROM $n)` 的 `$n` 必须显式 `::int`：无类型参数会让 PG 选中 `substring(text FROM text)`
  的**正则重载**，子树路径重算会静默写出错误值（NULL → 23502，或把匹配片段拼到路径尾部）。
- meta 的 form.fields 不得重复字段自身已声明的事实（`required`/`edit`），否则注册期即抛
  （`assertBasicFormDoesNotRepeatFieldFacts`，工单 49 收口的机制）。
- Hono 挂载点不匹配尾斜杠：集合根请求路径是 `/system/departments`，写成 `/system/departments/`
  会落到全局 notFound（表现为 404 「资源不存在」，容易误判成授权 not_found）。
- 新增资源要同步三处快照断言：`catalog-seal.test.ts` 资源计数、`resource-authz.test.ts` 形态分布、
  `menu-permission-contract.test.ts`（菜单项必须注解 `relatedPermissions`，否则新前缀无菜单归属即红）。
- 停用部门的语义：只拦**新挂接**（`resolveUserDepartment` 的 `attaching` 按「部门是否变化」传入），
  存量挂接的用户改其他字段不受影响。
- `restTransport` 的 `strictListLabel` 会拒收 `fixedFilter`/`extraFields`：需要按公司收窄的页面
  （树页、按公司分栏页）不能带这个标记，否则页面一开就 fail-closed。
