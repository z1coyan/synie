# 08 — 试点：标准公司域模块（其他库存单链）

**What to build:** 以 inventory 的手工出入库/调拨/盘点三单据（`inv.stock_doc`/`inv.stock_transfer`/`inv.stock_count` + 分录/余额投影视图）为「平凡多数」模板做整模块迁移：routes 挂 guard、服务签名 Permit 化、list/load 走两个共享执行点、工作流动作（audit/void/approve/cancel/ship/receive）逐动作 guard。产出**扫荡迁移手册**（checklist 化的机械步骤 + 常见坑），供 09-12 按模块复制。此模块现状覆盖 4 写法公司闸中的 3 种，可验证语义统一后行为不回归。

**Blocked by:** 04

**Status:** done

- [x] 三单据 + 分录/余额资源 authz 声明与全量迁移；`requireAnyPermission` 等 inventory 本地包装删除
- [x] 工作流动作全部经 guard；状态守卫保持 conflict 不动（划界验证）
- [x] forbidden→not_found 语义变化点逐一列举进 PR 描述（前端 QueryState 提示随 14 收口）
- [x] 现有 inventory postgres/integration 测试全绿，补 dept/self 范围用例（该模块暂无 owner/dept 声明即断言矩阵只出 all）
- [x] 《扫荡迁移手册》落 `.scratch/authz-rewrite/sweep-guide.md`
- [x] 封路豁免移除 inventory 三单据项

## Comments

**authz 声明与理由（声明本已存在，本轮复核 + 补理由注释）**

| 资源 | 声明 | 理由 |
|---|---|---|
| `invStockDocs` / `invStockTransfers` / `invStockCounts` | `{ kind: 'company' }` | 自带 `company_id`；手工库存单据不按人/车间看单，**故意不声明 owner/dept**（`created_by_id` 只是审计列），`supportedScopes` 只出 `[all]` |
| `invStockDocItems` / `invStockTransferItems` / `invStockCountItems` | `{ kind: 'via', parent, fk }` | 子行判定必须递归单头（行虽有 `company_id`，但「能不能看这一行」的答案就是「能不能看这张单」）；via 的 `supportedScopes = []` 也避免与同前缀单头取交集 |
| `invStockEntries` | `{ kind: 'company' }` | 来源单据是多态的（`voucher_type`/`voucher_id`），静态 via 只能声明单 parent；分录自带公司列，退回公司域 |
| 余额投影 | **不是资源** | 余额是 `inv_stock_entry` 的单公司聚合真值（引擎 `balance`），无表无 meta。共用 `inv.stock_entry:read` 码 + 公司边界（新增平台判定 `companyInPermitScope`），公司不在边界内返回**空结果** |

**三个执行点的覆盖统计**

旧原语调用点 74 处（`requirePermission` 40 / `canAccessCompany` 27 / `companyScopeWhere` 7）清零，换成：

- 路由 **40 个端点**逐个 `guard(资源, 动作)`（分录 3 + 出入库 15 + 调拨 15 + 盘点 17，含工作流 audit/void/ship/receive/approve/cancel）。
- **7 处 `listAuthorized`**（三单据的头/行 6 + 分录 1），全部显式传 `alias`。
- **7 处 `loadAuthorized` / `loadAuthorizedFrom`**（三单据头各 1 + 行各 1 + 分录投影 1），
  经 `loadDoc/loadCount(handle, permit, id, forUpdate)` 与 `parentOf` 两个闭包 helper 覆盖 25 条写路径；
  三个模块级 `lockDraftX(db, actor, id)` 私有函数删除（授权归平台，只留状态守卫两行）。
- 写侧 **3 处 `assertCompanyWritable`**（三单据 create）+ **1 处 `companyInPermitScope`**（余额聚合）；
  `created_by_id` / `shipped_by_id` / `received_by_id` 改 `permit.actor.userId || null`。
- 过账骨架（`auditInventoryDocInTx` / `voidInventoryDocInTx`）签名未动，传 `permit.actor`——
  引擎与骨架是受信任内核，鉴权停在服务层边界。**引擎签名里没有 actor**（`engines/inventory` 只收 trx +
  voucher + lines），无需处理。

**状态守卫划界验证（结论：一处未动，全留服务层 conflict）**

`仅草稿…可修改或删除` / `可审核` / `可发货` / `可收货` / `仅已审核…可作废` / `仅草稿…可编辑单据行` /
`审核前必须至少填写一行` / `实收数量必须在 0 与发货数量之间` / `库存已在快照后变化` / `出入库方向不可变更`
（validation）—— 全部仍在服务层抛 `conflict`/`validation`，且顺序固定为
**授权（404）→ 状态（409）**：`loadAuthorized` 先取行，取不到就是 404，取到了才谈状态。
HTTP 用例逐条断言 409（见下）。

**语义变化点（逐路径）**

| 路径 | 旧 | 新 |
|---|---|---|
| 三单据单条 get / patch / delete / audit / void / ship / receive / approve / cancel / refresh：跨公司 | `forbidden` 无权操作该公司数据 | `not_found`（手工出入库单/手工调拨单/库存盘点单不存在） |
| 三单据的行 get / patch / delete：母单跨公司 | `forbidden`（且只按行自己的 `company_id` 判断） | `not_found`（via 递归母单谓词） |
| create（三单据）：目标公司未授权 | `forbidden` 无权操作该公司数据 | `not_found` 公司不存在 |
| create：`companyId` 缺失且公司未授权 | 调拨单先报 `必填`，出入库/盘点先报 `forbidden` | 统一先 400 入参校验，再 404 公司边界 |
| 分录单条 get：跨公司 | `not_found`（本就是） | `not_found`（不变） |
| 三单据 + 行 + 分录列表 | 只按公司过滤（零公司授权时手工 `empty` 早退） | 公司 ∧ 范围原子编译（空行集编译为 `false`） |
| 列表带 `companyId` 过滤且该公司未授权 | 返回该公司数据（过滤条件与授权谓词无交集校验） | 空列表（领域筛选 ∧ 授权谓词） |
| 余额 `POST /stock-balance/query`：公司未授权 | `forbidden` 无权查看该公司数据 | `200` + 空 `results` |
| 盘点 `refresh` | 服务内 `inv.stock_count:update` | 路由 `guard(invStockCounts, 'update')`（同码，meta 未声明 refresh 动作，不新增权限码） |
| `inv.stock_doc` / `inv.stock_transfer` / `inv.stock_count` / `inv.stock_entry` 的 `supportedScopes` | 无投影 | `[all]`（矩阵不得授出 dept/self；授了也只会 fail-closed 成空集，有用例） |

**测试**

- 新增 `test/inventory-authz.integration.test.ts`（8 例全绿，全程走 HTTP）：
  三角色（甲库管 scope=all / 甲只读只有 read 码 / 双公司库管）× 两公司。
  1. 未登录 401（guard 在 requireAuth 之后）。
  2. 只读角色的 11 个写/工作流端点全部 403，且只读码本身可用（200）。
  3. 跨公司 17 条单条路径全部 404（读/写/工作流/子行）。
  4. create 到未授权公司 → 三单据都 404。
  5. 列表按公司收窄 + 每条列表路径的别名回归（本公司行必须在结果里）+ 分录投影四字段带出 +
     带 `companyId=乙` 过滤 → count 0。
  6. 余额：本公司出数（`quantity === '10'`），未授权公司空结果。
  7. 状态守卫 7 条断言全 409（含行编辑草稿门）。
  8. `scope=dept` 授给无 dept 绑定的资源 → 列表空 + 单条 404 + 列表端点仍 200（码级满足）。
- `src/modules/inventory/inventory.postgres.test.ts`：Actor 改 `permit()` 现取（46 处调用），
  5 例全绿；`ensureBaseline` 会改写 actor.userId，故凭证不能提前算一次。
- 快照：`resource-authz.test.ts` 加一例「三单据 + 分录只出 all、子行为 []、无 owner/dept 绑定」；
  `catalog-seal`（105）与形态分布（company 34 / global 35 / via 36）**不变**（未新增资源、未改形态）；
  `menu-permission-contract` 不变（前缀集合没变）。
- 全量：`532 pass / 3 fail`（535 across 81 files）。3 例失败是既有基线红
  （hr `meta.grid` 形状、printing `61 vs 64`、market），与本轮无关。
- server / web `typecheck` 干净。未起 dev（按工单要求）。

**封路豁免**

删 5 行：`stock-doc-service.ts` / `stock-transfer-service.ts` / `stock-count-service.ts` /
`stock-entry-service.ts` / `helpers.ts`，规模断言 43 → 38。

牵连处理（本工单顺势做的最小改动）：

- `helpers.ts` 的 `requirePermission` 再导出与 `requireAnyPermission` 删除后，
  四个主数据服务（material / material-unit / warehouse / category，属工单 11）改为直接
  `import { requirePermission } from '~/platform/authz/actor.ts'`；`requireAnyPermission`
  下沉为 `material-unit-service.ts` 的本地 `@deprecated` 私有函数（唯一消费者）。
  它们仍在豁免清单里，工单 11 一并清零。
- `modules/setup/sampledata/inventory.ts`（示例数据种子）是已迁服务的域外调用方：
  `SampleDataDeps` 加 `authz`，种子按 actor 现取凭证（`permitFor`）。
  **不能用 `systemPermit()`**：`created_by_id` 有 `sys_user` 外键，system 主体 id 是全零且无用户行。
- `composition.ts` / `app.ts` / `setup.integration.test.ts`：`createInventoryServices(db, numbering, registry)`
  与 `inventoryRoutes({ authz })` 的接线。

**坑（新踩的，已并入 sweep-guide.md）**

- 入参校验与公司边界的**顺序**是语义：`assertCompanyWritable` 必须放在 `fields` 校验之后，
  否则 `companyId: ''` 会先撞公司边界报「公司不存在」（旧代码调拨单是 `if (input.companyId && …)`
  短路掉的，出入库/盘点则是先判公司）。手册定为统一规则：400 先于 404。
- 子行写路径的加锁顺序必须**母单先行**：`parentOf`（`loadAuthorized(forUpdate)` + 草稿门）→ 再
  `FOR UPDATE` 锁行。原代码就是这个顺序，图省一次查询把 via 链的 `loadAuthorized(item, forUpdate)`
  提到前面就会与并发路径反向加锁。
- 单公司聚合端点（余额）既不能套逐行过滤（分录无行级绑定列，dept 谓词会编到不存在的列上），
  也不能只做码级门控（那是真的跨公司数据泄露）。归宿是新增的 `companyInPermitScope(permit, companyId)`
  → 不命中返回空结果。`assertCompanyWritable` 复用它，语义不变。
- 列表与单条共用一份 `source`/`select` 常量（`stock-entry-service.ts`）后，别名只有一处可写错；
  分录的投影别名特意起成表名 `inv_stock_entry`，`alias` 传同名，肉眼即可对拍。
- Hono handler 里 `app.request(...)` 的返回类型是 `Response | Promise<Response>`：
  集成测试把用例装进 `Array<[label, () => Promise<Response>]>` 会 typecheck 失败，得写成
  `() => Promise<Response> | Response`。
- 测试里 actor 会被 `ensureBaseline` 改写（补 userId）：凭证必须每次现取，
  否则 `created_by_id` 落在旧的空 userId 上。

**留给后续（有意不在本工单动）**

- inventory 主数据（物料/分类/单位转换/仓库）仍走旧闸，含 `warehouse-service.ts` 里两处
  `forbidden` 公司闸 → 工单 11。
- 盘点 `refresh` 目前借 `update` 码。若产品要区分「刷新账面」与「改单」，那是新增权限码的独立决策，
  不在扫荡范围内顺手做。
- 前端（`web/app/routes/_app/inventory/*`）未动：wire 形状不变，跨公司从 403 变 404 的提示文案
  随工单 14 的 QueryState 收口一起处理。
