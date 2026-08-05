# 07 — 试点：需求单下发车间（指派部门形态）

**What to build:** dept=assigned 形态的第一消费者，验收 spec §2 冲压车间场景：`mfg_demand` 加 `assigned_dept_id`（可空 FK → sys_department，限本公司部门）；meta 声明 `dept: { column: 'assigned_dept_id', mode: 'assigned' }`；草稿态表单可填可改，已确认后改派走新工作流动作 `dispatch`（下发/改派，权限码 `mfg.demand:dispatch`，仅已确认未关闭可用，写审计）。工单资源（`mfg.work_order`）声明归属部门形态（`owner_dept_id` 盖章列）作对照。E2E：冲压车间生产经理（`mfg.demand:read scope=dept` + 工单全套 scope=dept）只见下发本车间的需求单、可从行安排工单、看不到其他车间/未下发单；计划角色 scope=all 全量可见。

**Blocked by:** 04, 05

**Status:** done

- [x] 迁移：mfg_demand.assigned_dept_id；mfg_work_order.owner_dept_id（盖章列）
- [x] meta 声明两形态 + dispatch 动作（目录、路由 guard、服务 Permit 化）
- [x] 需求单/工单/生产入库服务全量迁 Permit + loadAuthorized + listFromSource v2
- [x] 表单：下发车间字段（RemoteSelect 限本公司部门）；列表列可筛
- [x] 场景 E2E（种子建部门与角色授权，矩阵 UI 未到位前走 API 授权）
- [x] 产品文档：生产管理篇补下发车间；封路豁免移除 manufacturing 需求单/工单项

## Comments

**实施落点**

- 迁移 `server/db/migrations/00019_mfg_dept_dispatch.sql`：两列都可空 + FK + 索引 + 列注释；
  `src/db/types.d.ts` 用 `kysely-codegen` 对测试库重新生成（差异恰是两列）。
- meta（`modules/manufacturing/meta.ts`）：
  `mfgDemands` → `authz: { kind: 'company', dept: { column: 'assigned_dept_id', mode: 'assigned' } }`
  \+ fk 字段 `assignedDeptId` + 动作 `{ key: 'dispatch', label: '下发车间', scope: 'row' }`；
  `mfgWorkOrders` → `authz: { kind: 'company', dept: { mode: 'stamped' } }` + 只读 fk 字段 `ownerDeptId`。
- 服务：`demand-service.ts` / `work-order-service.ts` / `output-service.ts` 全量 Permit 化
  （`listAuthorized` / `loadAuthorized` / `assertCompanyWritable`），三份文件零鉴权代码；
  `helpers.ts` 的 `actorUserId` 随之成死码删除（`created_by_id` 改写 `permit.actor.userId || null`）。
- 路由（`routes.ts`）：需求单/需求行/工单/入库/入库行逐端点 `guard(资源, 动作)` + `permitOf(c)`；
  新端点 `POST /demands/:id/dispatch`。主数据（工序/工艺模板/BOM/模具）仍走 actor，留给工单 11。
- 前端：`lib/resources/manufacturing.ts` 加 `dispatchDemand`；
  `presentation/manufacturing-documents.tsx` 给 `mfgDemands` 加 `assignedDeptId`（自定义 `input`，
  候选按表单已选公司 ∩ 启用中收窄），`mfgWorkOrders` 把 `ownerDeptId` 并入 exclude（盖章列不进表单，
  与 `createdById` 同类）；`mfg/demands/-dispatch-dialog.tsx` 新弹窗（RemoteSelect 选车间 + 写后
  显式 invalidate）；`demands/orders.tsx` 加 `assignedDeptId` 列与 `dispatch` 行动作（`CONFIRMED` 才显）；
  `work-orders.tsx` 加 `ownerDeptId` 列。

**dispatch 的状态机与审计**

```
草稿   → 下发车间随表单（PATCH /demands/:id，assignedDeptId 可填可清空）
已确认 → 只能走 POST /demands/:id/dispatch（要求非空车间；改派即再调一次）
已关闭 / 已作废 → conflict（状态守卫在服务层，划出权限系统）
```

审计走既有范式：`writeAudit(actionType: 'update', actionName: 'dispatch')`，
`changes = auditDiff(demandSnap(before), demandSnap(after), DEMAND_AUDIT)`——
`assigned_dept_id` 是 meta 物理字段，`auditFieldsOf` 自动纳入，无手抄字段数组。
值未变则不写审计（与 update 同口径）。

**盖章执行点（平台已有 + 本轮补一层）**

`db/load.ts:ownershipStamp`（工单 04 就位）此前**零消费者**。本轮补 `withOwnershipStamp(values, permit, target)`
薄包装：把盖章列并入 insert values 且保持入参类型（kysely `InsertObject` 校验照旧生效），
故模块侧不写 `owner_dept_id` 字面量。工单创建即 `withOwnershipStamp(...)`，
无部门用户盖 NULL（`permit.actor.deptId` 为 null）。

**guard allOf 的三处跨资源门控（不写字面量权限码，从 `authz.targetOf(资源).prefix` 拼）**

| 端点 | 附加码 | 理由 |
|---|---|---|
| `POST /work-orders` | `mfg.demand:read` | 从需求行建单，来源单据必须可达（车间只能拿下发到本部门的需求单开工） |
| `POST /output-items`、`PATCH /output-items/:id` | `mfg.work_order:read` | 入库行引用工单，只能拿看得见的工单入库 |
| `POST /work-orders/:id/create-bom` | `mfg.bom:create` | 取代服务内两次 `requirePermission` |

`allOf` 的范围取格上最小（保守），故来源单据的行级可达性与本资源写入同时成立，无需两张凭证。

**E2E 断言清单（`test/demand-dispatch.integration.test.ts`，9 例全绿）**

种子：公司 A（+ 公司 B 只为跨公司校验）、冲压/装配两车间、计划员（13 个码 scope=all，无部门）、
冲压车间经理（需求单只读 + 工单四码，scope=dept，挂冲压车间）。全程走 HTTP。

1. 下发/改派写审计：`dispatch` 审计 3 条，`changes` 含 `assigned_dept_id`；计划员自身无部门也能下发（指派列不受 actor 部门约束）。
2. 草稿单 dispatch → 409；跨公司车间 → 400 validation（`assignedDeptId: 车间必须属于需求单所在公司`）。
3. 草稿两条写路径：create 带 `assignedDeptId` → 201 且车间可见；PATCH 清空 → 车间不可见。
4. 需求行随母单可达（via 链）：车间列表只含冲压单的行，他车间行单条 404、本车间行 200。
5. 车间只见冲压单；装配单与未下发单列表不含 + 单条 404；计划员三张全见。
6. 车间无 `dispatch` 码 → 403 forbidden（码级先于行级）。
7. 车间从冲压单的行建工单 → 201 且 `ownerDeptId` = 冲压车间，自己列表可见。
8. 车间拿装配单的行建工单 → 404（不泄露需求行存在性）。
9. 无部门的计划员建的工单 `ownerDeptId` 为 null：计划员（all）可见、车间（dept）列表不含 + 单条 404。

**语义变化点**

| 路径 | 旧 | 新 |
|---|---|---|
| 单条读/改/工作流：跨公司 | `forbidden` 无权访问该公司数据 | `not_found`（需求单/工单/入库单不存在） |
| 列表带 `companyId` 且该公司未授权 | `forbidden` | 空列表（领域筛选 ∧ 授权谓词，不泄露） |
| 建工单：来源需求行跨公司/不可达 | `forbidden` | `not_found` |
| 建/改入库行：工单不可读 | 只要 `mfg.output:create` | 另需 `mfg.work_order:read`（缺码 `forbidden`，行不可达 `not_found`） |
| 工单内嵌建 BOM | 服务内两次 `requirePermission` | guard allOf 一次判定（语义不变） |
| 需求单/工单/入库单列表 | 只按公司过滤 | 公司 ∧ 范围原子（`scope=dept` 即按指派/归属部门收窄） |
| `mfg.demand` / `mfg.work_order` 的 `supportedScopes` | `[all]` | `[all, deptTree, dept]`（矩阵可授部门范围，UI 是工单 13） |

`POST /sales-item-occupancies` 有意**不**叠加行级可见性：占用量是对全部已确认需求单的聚合业务真值，
按读者范围过滤会让可占用量虚高。码级门控（`mfg.demand:read`）不变。

**封路豁免**

移除三行：`demand-service.ts` / `output-service.ts` / `work-order-service.ts`，规模断言 46 → 43。
留下的 manufacturing 项与原因：

- `helpers.ts`：`requirePermission` 再导出 + `requireCreateOrUpdate`（anyOf 形态），master-service 还在用 → 工单 11。
- `master-service.ts` / `mold-design-service.ts`：BOM/工序/工艺模板/模具设计资源本身不在本工单范围 → 工单 11。
- `work-order-docbuilder.ts`：`canAccessCompany` 是打印 `DocBuilder(actor, ids)` 接口决定的，
  改签名要动 platform/printing 与 trading 的 docbuilder → 工单 09（printing 归属那批）。

**测试与验证**

- server `bun test`：`522 pass / 3 fail`（526 across 80 files）。3 例失败是既有基线红
  （hr / printing `61 vs 64` / market），与本轮无关；另有 order-draft 并行截断偶发红（单文件 18 pass）。
- `src/modules/manufacturing/` 20 例全绿（补了四个列表路径的 via/别名回归：入库行、需求行、工单、入库单、需求单）。
- 快照两处：`resource-authz.test.ts` 的 supportedScopes 断言改为「按前缀期望表」并加一例两形态绑定列断言。
  `catalog-seal`（资源计数 105）与形态分布（company 34 / global 35 / via 36）**不变**——本轮不新增资源，
  只改既有声明；`menu-permission-contract` 也不变（前缀集合没变）。
- server / web `typecheck` 干净；web `bun test` 292 pass。未起 dev（按工单要求）。

**坑**

- `db/load.ts:ownershipStamp` 返回 `Record<string, string | null>`，直接 spread 进 kysely `.values()`
  会因索引签名破坏 `InsertObject` 校验（`qty: Numeric` 收不下 `string | null`）。
  故加 `withOwnershipStamp<T>(values, permit, target): T`，转换在平台内一次性完成。
- `listAuthorized` 的 `alias` 必须与投影子查询的别名逐字一致（需求行是 `mfg_demand_item`、
  入库行是 `mfg_output_items` 带 s）——写错不会报错，via 链的 EXISTS 会静默把行集算成空。
  这类 SQL 别名 typecheck 与单测都看不见，务必给每个列表路径留一条回归。
- `ApiError.validation` 是 HTTP **400** 不是 422（第一版 E2E 断言写错）。
- `salesOccupancies` 这类聚合端点不要套行过滤：`compileRowFilter` 会把 dept 谓词编到
  `sal_order_item.assigned_dept_id`（不存在的列）上。跨资源聚合只做码级门控。
- 工单/需求单加 fk 字段会自动进**打印字段目录**（`owner_dept.*` / `assigned_dept.*`）。
  渲染器对缺失占位符只输出空串（不报错），但为不留空占位，工单 docbuilder 补了
  `LEFT JOIN sys_department` 与 `owner_dept.code/name`。
- 车间角色若没有 `sys.department:read`，列表的部门 fk 列只能显示 id 前缀（`FkLink` 反查被 meta
  投影降级为 `targetUnavailable`）。下发/选车间的角色需要顺带授这个码。

**留给后续（有意不在本工单动）**

- 停用车间：新下发被拦（`resolveAssignedDept` 校验 enabled），存量下发保留——与用户挂部门同口径，
  但「车间停用后其未完工单据由谁接」是组织流程问题，没做迁移工具。
- `mfg.demand:dispatch` 只支持下发到非空车间；「撤销下发」（改回未下发）目前只有草稿态表单能做。
  真实需求出现时再决定是否放开（会引入第三种状态语义）。
- 前端行级判定仍靠 `actionVisible` 手写状态机 + 服务端兜底；同一代数的客户端本地求值是工单 14。
