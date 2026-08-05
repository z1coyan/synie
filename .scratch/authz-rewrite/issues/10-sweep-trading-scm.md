# 10 — 扫荡：trading（销/采全链）/ scm

**What to build:** 按 08 手册迁移 trading（订单/报价/发货/入库/对账/委外，双边 spec 驱动）与 scm（orderflow 投影）。要点：`requirePerm` 包装与 `orderSpec(side).prefix` 动态拼码改为 meta 动作 + guard；`lockOrder`/`lockDraft` 折叠进 `loadAuthorized(forUpdate)`；orderflow 的 via.anyOf（03 已声明）在此接执行点，删路由与服务的两份手写析取；对账 confirm/unconfirm 等工作流动作逐动作 guard。

**Blocked by:** 08

**Status:** done

- [x] trading 全部子域迁移，`trading/common.ts:requirePerm` 删除
- [x] scm orderflow 走 via 执行点，手写析取删除
- [x] 子行 items 资源 via(parent) 声明生效（前端覆盖删除在 14）
- [x] 相关集成/E2E 测试全绿；封路豁免移除对应项

## Comments

### 实施落点

| 子域 | 服务 | 路由 | 备注 |
|---|---|---|---|
| 报价（销/采） | `trading/quotation/service.ts` | `quotation/routes.ts` | 头/条目/价格档三层，档位是两级 via |
| 订单（销/采） | `trading/order/service.ts` | `order/routes.ts` | 双边 spec 驱动；`lockOrder` 折叠 |
| 委外配置（采） | `trading/order/outsourced-config.ts` | 同上（purchaseOrderExtraRoutes） | 发料/副产物清单 = via(purOrderItems→purOrders) |
| 履约（发货/入库/装箱） | `trading/fulfillment/service.ts` | `fulfillment/routes.ts` | 装箱行两级 via |
| 委外单据 | `trading/outsourced/service.ts` | `outsourced/routes.ts` | 发料/入库两组，材料/副产物两级 via |
| 对账（销/采） | `trading/reconciliation/service.ts` | `reconciliation/routes.ts` | confirm/unconfirm/audit/void 逐动作 guard |
| 订单流水投影 | `scm/orderflow/service.ts` | `orderflow/routes.ts` | readAnyOf 四码；两份手写析取删除 |
| 公司默认科目 | `sales/company-account-default.ts` | `sales/routes.ts` | sales.setting 前缀 |
| 装配 | `trading/index.ts` / `scm/index.ts` / `sales/index.ts` / `composition.ts` / `app.ts` | — | 服务构造末位收 `registry`，路由 deps 收 `authz` |
| 种子 | `setup/sampledata/{chains,outsourced,master}.ts` | — | 一律 `permitFor(deps, actor, 资源, 动作)` 现取凭证 |

`trading/common.ts:requirePerm` 已删除（文件只剩金额/日期/物料快照等纯工具）。
`trading/order/docbuilder.ts` 早在工单 09 就已是 `findAuthorized(permit)`，本轮只更正过期注释——故它**不在**封路豁免清单里（工单描述里的「trading 8 行」实为 7 行）。

### 双边 spec 驱动怎么归位 meta

- 旧形态：服务里 `requirePerm(actor, orderSpec(side).prefix, action, …)` —— **权限码由 spec 动态拼**，meta 的 actions 与执行完全无关。
- 新形态：**路由按 side 选资源名**（`orderSpec(side).headResource` / `.itemResource`，报价/履约/对账同理），`authz.guard(资源, 动作)` 查 sealed registry 把 (资源, 动作) 解析成码；服务方法保留 `side` 参数**只决定表与领域差异**，鉴权零代码。
- 结果：`sales.order:*` 与 `purchase.order:*` 两套码的事实源回到各自 meta 的 `actions`，双边对称没有被破坏（同一个 `listHeads/getHead/transition` 服务方法，两组路由、两组资源名、两组码）。
- 跨资源附加码一律 `authz.targetOf(资源).prefix` 拼，路由里没有权限码字面量。

### 声明形态清单（全部沿用工单 03 的既有声明，本轮零新增权限码）

| 资源 | 形态 |
|---|---|
| `salQuotations` / `purQuotations` / `salOrders` / `purOrders` / `salDeliveries` / `purReceipts` / `purOutsourcedIssues` / `purOutsourcedReceipts` / `salReconciliations` / `purReconciliations` / `salCompanyAccountDefaults` | `company`（`company_id`） |
| `salQuotationItems` / `purQuotationItems` | `via(…Quotations, quotation_id)` |
| `salQuotationTiers` / `purQuotationTiers` | 两级 `via(…QuotationItems, item_id)` → 头 |
| `salOrderItems` / `purOrderItems` | `via(…Orders, order_id)` |
| `purOrderItemMaterials` / `purOrderItemByproducts` | 两级 `via(purOrderItems, order_item_id)` → `purOrders` |
| `salDeliveryItems` / `purReceiptItems` | `via(…, delivery_id / receipt_id)` |
| `salDeliveryPackBoxes` | `via(salDeliveries, delivery_id)` |
| `salDeliveryPackLines` | 两级 `via(salDeliveryPackBoxes, pack_box_id)` → `salDeliveries` |
| `purOutsourcedIssueItems` / `purOutsourcedReceiptItems` | `via(…, issue_id / receipt_id)` |
| `purOutsourcedReceiptItemMaterials` / `…Byproducts` | 两级 `via(purOutsourcedReceiptItems, receipt_item_id)` → 入库头 |
| `salReconciliationItems` / `purReconciliationItems` | `via(…Reconciliations, reconciliation_id)` |
| `scmOrderFlowItems` | `company` + `readAnyOf: [purchase.receipt:read, purchase.outsourced_issue:read, purchase.outsourced_receipt:read, sales.delivery:read]` |

唯一的 meta 改动：`salCompanyAccountDefaults` 原 `actions: []`（guard 的 `assertActionDeclared` 会 500），补 `actions: [read, update]`；两码在 `sales.setting` 前缀下由 `trading/settings.ts` 早已声明，**权限目录前后逐字不变**（测试锁死）。资源集与形态分布未变，三处快照无需改。

### orderflow：声明即执行

`resolveAuthzTarget` 的 `readAnyOf` 取「请求资源声明优先、宿主回落」（`requireAuth(requested).readAnyOf ?? requireAuth(root).readAnyOf ?? []`）；`enforce.ts` 两处消费它：`assertActionDeclared`（read + readAnyOf 非空即放行，故 `actions: []` 的只读投影不再 500）与 `requirementFor`（编译成 `anyOf(codes)`）。路由 `requireOrderFlowRead()` 与服务 `requireRead()` 两份手写析取**已删除**。集成证明：四码逐个单独持有均 200 且能读到本公司行、四码全缺 403；行集仍受公司边界收窄（码级析取 ∧ 行级公司谓词）。

### lock*/执行点折叠统计

| 位置 | 旧 | 新 |
|---|---|---|
| `order/service.ts:lockOrder`（joined FOR UPDATE + canAccessCompany） | 1 个模块级函数 / 7 调用点 | 闭包 `loadAuthorized(forUpdate)` + `loadHead` 投影 |
| `order/outsourced-config.ts:lockPurchaseItemParent` | 1 / 7 | `lockOrderOfItem`（母单 `loadAuthorized(forUpdate)` + 草稿门） |
| `quotation:lockHead` / `lockDraftHead` | 2 / 11 | 闭包两段 + 新增 4 处子行 `FOR UPDATE`（母单先行） |
| `fulfillment:lockHead` / `lockDraftHead` | 2 / 13 | 闭包两段 + 新增 2 处子行锁 |
| `outsourced:lockIssue/lockDraftIssue/lockReceipt/lockDraftReceipt/lockReceiptForItem` | 5 | 2 处 `loadAuthorized(forUpdate)` + 2 个草稿门闭包 |
| `reconciliation:lockHead` | 1 / 7 | `loadAuthorized(forUpdate)` + `queryHead` 投影 |
| **合计** | **12 个模块级 lock 函数** | **全部折叠，加锁顺序恒为母单先行** |

同批删除：`requirePerm` 调用 **122 处**、`canAccessCompany` **约 49 处**、`companyScopeWhere` + `empty` 早退 **20 组**、`hasPermission` 手写析取 **4 处**；`listFromSource` → `listAuthorized` **22 条列表路径**；单条读 → `loadAuthorized` / `loadAuthorizedFrom` **约 30 处**；`writeAudit(trx, actor, …)` → `permit.actor` 全量；过账骨架（库存/GL）与 `created_by_id` 同理。**服务层已无 `forbidden` 文案**（trading/scm/sales 全域 grep 为空）。

### 语义变化表（逐路径）

| 路径 | 旧 | 新 |
|---|---|---|
| 头单条读/改/删/工作流（订单/报价/发货/入库/委外/对账，双边）：跨公司 | `forbidden` 或按行公司列判 | `not_found`（xx 不存在） |
| 子行（条目/档位/装箱箱/装箱行/发料清单/副产物/材料）单条读：母单不可达但行 `company_id` 命中 | **可读**（只按行公司列判） | `not_found`（via 递归母单谓词） |
| 子行列表：同上 | 按行公司列过滤 | via 链 EXISTS 递归母单（一级/两级） |
| create（订单/报价/履约/委外/对账/公司默认科目）：目标公司未授权 | `forbidden`「无权在该公司下操作数据」 | `not_found`「公司不存在」 |
| create：`companyId` 为空 | 先撞公司闸（报「公司…」） | 400「必填」（入参校验先于公司边界） |
| 任一端点：缺动作码 | 服务层 `forbidden`（各模块自定文案） | guard 产出 `forbidden`（403 唯一成因＝码不满足） |
| 所有列表：零公司授权 / 跨公司 | `empty` 早退返回空列表 | 空列表（行过滤编译为 `false`，早退义务消失） |
| **聚合 PUT 整单替换（订单/报价/销售发货/采购入库）** | 只要 `update`；服务按子树差异**动态**追加 `create`/`delete` 并抛 `forbidden` | 路由**声明式** `update ∧ create ∧ delete`（缺任一码 403；服务层零判定）。销售发货侧由「只要 update」收紧为三码 |
| 采购订单需求池 `queryDemandPool`：公司未授权 | `not_found`「公司不存在」 | 空结果（跨资源单公司聚合按手册走 `companyInPermitScope`） |
| `company-account-defaults/by-company`：公司未授权 | `forbidden` | 空壳结果（与「该公司尚未配置」同形，保既有 wire 契约） |
| orderflow list/get：四码全缺 | 路由与服务各抛一次 `forbidden` | guard 一次 `anyOf` 判定 → `forbidden` |
| 发票联动接缝（`closeFromInvoice` / `reopenFromInvoice`） | 收 `actor`，不做公司判定 | **不变**（finance 属工单 12） |
| 各 trading 前缀 `supportedScopes` | `[all]` | `[all]`（未加 owner/dept 绑定，矩阵不新增档位） |

### 保留 `actor` 的跨模块接缝（工单 12 再收）

- `reconciliation.closeFromInvoice / reopenFromInvoice / invoiceState`：由 `finance/invoice-service.ts` 在自己的事务里调用，本就不做公司判定（actor 只用于 `writeAudit`）；`existsForInvoice` / `loadForInvoiceAudit` 无 actor。
- 平台既有签名（非模块鉴权）：`writeAudit(trx, actor, …)`、`platform/posting/skeleton.ts` 的四个过账骨架、`quotations.resolveForOrder`（纯查询）——一律传 `permit.actor`。

### 坑（本轮新增到手册之外的）

1. **投影行锁必须两段**：`lockOrder`/`lockHead` 这类「joined 投影 + FOR UPDATE」不能直接换成 `loadAuthorizedFrom`（子查询不能 FOR UPDATE）。正解：`loadAuthorized({ forUpdate: true })` 在裸表上完成授权+锁，再用原 join 查询取投影（`base/account-service.ts` 的 lock+reload 范式）。
2. **文本主键资源不能走 `loadAuthorized`**：`scm_order_flow_item.id` 是 `flow_type:uuid`，而 `db/load.ts` 会把 id 转 `::uuid`。这类只读投影直接用 `compileRowFilter(permit, target, alias)` 拼进原 SQL 的 WHERE（仍是 db 适配层的公开执行点，不是模块自造判定）。
3. **`actions: []` 的资源挂 guard 会 500**：`assertActionDeclared` 只对 `read + readAnyOf` 放行。要么声明 `readAnyOf`（orderflow），要么补 meta actions（公司默认科目，且必须确认权限目录不变）。
4. **别名回归必须用非 superAdmin 的公司域 actor**：superAdmin 的 rowFilter 是 bypass，`compileRowFilter` 直接返回 `true`，别名写错也测不出来。各子域已用「故意写错别名→用例转红」实证过断言有牙。
5. **聚合草稿的动态权限无处安放**：判定依赖请求体 ∧ 库内既有子行，路由算不出、服务又不许抛 forbidden。定案：端点级 `allOf`（替换语义天然含增删），登记为语义变化。
6. 种子/测试夹具的 `bas_unit.symbol`、`bas_currency.iso_code` 全局唯一，多套件并行会 23505 撞车——本轮把 trading 各测试的夹具按 suffix 唯一化。

### 测试数字

- 单文件：quotation 14 pass（2 文件）、fulfillment 28 pass（2 文件）、outsourced 6 pass、reconciliation 15 pass（2 文件）、order 18 pass（4 文件）、scm+sales 10 pass（2 文件）。
- 新增端到端：`server/test/trading-scm-authz.integration.test.ts` **7 用例 / 65 expect 全绿**——五条列表路径别名回归（销/采订单头、销/采订单条目、orderflow）、七条跨公司 404（含 via 子行、history、orderflow 文本主键）、七条缺码 403 + 同角色读 200 对照、聚合 PUT 缺码 403 / 齐码非 403、重复审核 409（不是 403/404）、orderflow anyOf 单码 200 / 全缺 403、trading 前缀 `supportedScopes === ['all']`。
- 全量：`SYNIE_TEST_DATABASE_URL=… bun test` → **575 tests / 84 files，572 pass，3 fail**，三个失败全是既有基线红（hr / market / printing integration，与本轮无关）。`order-draft` 的 issueLines 顺序断言在并行全量跑时偶发红（`loadOrderDraftLines` 按 `oi.idx, m.id` 排序，新旧行 uuid 大小随机），单文件跑稳定全绿——属既有夹具问题，未纳入本轮修复。
- `cd server && bun run typecheck` 0 error；`cd web && bun run typecheck` 0 error；`web/app/lib/menu-permission-contract.test.ts` 3 pass。
- 封路豁免：删 10 行（trading 7 + scm 2 + sales 1），`EXEMPT.size` 上限 28 → **18**，三例全绿。

### 未尽事项（不阻塞本单）

- 前端 `capabilities={[...]}` 硬覆盖仍在（子行资源已能正确投影），按计划留工单 14。
- finance 侧调用对账的两个接缝仍传 `actor`，工单 12 迁 finance 时一并换成 `permit.actor`。
- `fulfillment.createPurchaseHead` 无路由消费（迁移前即如此），未做删减。
- `order-draft` 顺序断言的夹具级修复（给 issueLines 稳定排序键）建议并入工单 15 的测试资产换代。
