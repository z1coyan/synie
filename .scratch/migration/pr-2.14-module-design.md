# PR-2.14 共享订单模块设计勘察

> 状态：实现前设计初稿；只读勘察，未修改 `backend/` 或 Go 源码。撰写时
> `.scratch/migration/pr-2.14-contract.md` 尚未生成，开工前应以合同逐项复核本文的
> 「待合同定案」。

## 结论

销售与采购订单应落为一个深 Module：`server/internal/domain/trading/order`。共享的是整套
生命周期、订单分型、报价派生、金额链、快照和父单锁，而不只是几个校验函数。采购差异由
受控 `Side` 配置和采购专用文件表达，不复制第二套 transaction script。

推荐的 Interface 小于旧资源动作总和：

```go
type Side string // sales | purchase

func NewService(pool *pgxpool.Pool, numberer Numberer) *Service

func (s *Service) ListOrders(ctx context.Context, actor *authz.Actor, side Side, q ListQuery) (OrderListResult, error)
func (s *Service) GetOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error)
func (s *Service) CreateOrder(ctx context.Context, actor *authz.Actor, side Side, in CreateOrderInput) (Order, error)
func (s *Service) UpdateOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, in UpdateOrderInput) (Order, error)
func (s *Service) DeleteOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) error
func (s *Service) AuditOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error)
func (s *Service) CloseOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error)
func (s *Service) VoidOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error)

func (s *Service) ListItems(...)
func (s *Service) GetItem(...)
func (s *Service) CreateItem(...)
func (s *Service) UpdateItem(...)
func (s *Service) DeleteItem(...)
```

采购专用 Interface 留在同一 Module：

```go
func (s *Service) ListDemandPool(ctx context.Context, actor *authz.Actor, q DemandPoolQuery) (...)
func (s *Service) ListMaterials(...) / CreateMaterial(...) / UpdateMaterial(...) / DeleteMaterial(...)
func (s *Service) ListByproducts(...) / CreateByproduct(...) / UpdateByproduct(...) / DeleteByproduct(...)
func (s *Service) ApplyBOMSnapshot(ctx context.Context, actor *authz.Actor, itemID, bomID uuid.UUID) (...)
```

`ApplyBOMSnapshot` 比“前端读 BOM calculation 后逐行写清单”更深：一次事务完成 BOM/成品
匹配、理论耗用计算与两个快照清单写入。它不建立活引用；订单数量或 BOM 后续变化均不回溯。
若 PR-2.14 合同要求完全保留旧前端编排，可先不暴露该动作，但不可在多个 handler 重写计算。

路由注册时固定销售或采购 `Side`；不接收客户端任意表名/资源名。`Numberer` 沿用报价模块
已有 Interface（真实编号模块与测试替身已经是两个 Adapter），资源分别为
`sales.order`、`purchase.order`。

## 共性与真实变体

| 维度 | 共享不变量 | 销售变体 | 采购变体 |
|---|---|---|---|
| 表 | Head + Item；Item 从属 Head | `sal_order(_item)` | `pur_order(_item)`，另有 material/byproduct |
| 权限 | 子资源复用父订单权限；公司范围 fail closed | `sales.order` | `purchase.order` |
| 对手 | Party；内部公司不能等于本公司 | CUSTOMER / COMPANY | SUPPLIER / COMPANY |
| 状态 | DRAFT → AUDITED → CLOSED/VOIDED；无反审核；仅草稿可改删；空单不可审核 | 同 | 同 |
| 分型 | 类型创建后锁死；常规必须引用有效报价；审核再次复核 | REGULAR / SAMPLE | REGULAR / SPOT |
| 非常规上限 | 读取当前 `sal_setting`；按录入 qty 直接比较，不折默认单位；不可挂报价 | sample 上限 | spot 上限 |
| 常规取价 | 公司/对手/币种一致；订单日位于报价有效期；固定价或数量梯度；物料/单位/价格由报价派生；税率仅未显式传入时取报价 | 销售报价 | 采购报价；委外时价格仍是加工费报价 |
| 客户料 | 保存快照 | 通用料或当前客户料；内部公司仅通用料 | 不校验客户料归属 |
| 双币 | 本币默认且汇率强制 1；外币汇率必填且 >0；amount=round(qty×price,2)，base_amount=round(amount×rate,2)，base_price=round(price×rate,4)；改汇率同事务重算全部行 | 同 | 同 |
| 头冻结 | 有行后 company/party/date/currency 不可变；type 始终不可变 | 同 | `is_outsourced` 也创建后锁死 |
| 快照/附件 | 每次行保存重拍物料五列；drawing 挂接整删整建；删行/删头显式清 attachment | 同 | 同 |
| 履约投影 | 默认单位口径、系统受控、审核加/作废减 | `shipped_qty` | `received_qty`；沿订单行继续回写需求 `received_qty` |
| 需求 | 无 | 销售订单行会被履约需求引用，但不在本 Module 写占用 | 可空 `demand_line_id` + `demand_date`；审核占 `ordered_qty`，作废释放 |
| BOM | 无 | 无 | `bom_id` 只留痕，删除 BOM 时 SET NULL；清单是脱钩快照 |
| 委外清单 | 无 | 无 | material 有 `issued_qty` 投影；byproduct 无投影；都仅草稿可维护 |
| 作废阻挡 | 有已审核未作废的下游履约事实时拒绝 | 发货 | 普通入库及委外入库；需求占用随作废回滚 |

待合同定案：旧代码对 `bom_id`、material、byproduct 的结构校验只要求父订单为草稿，没有再次
要求 `is_outsourced=true`，而产品文档把它们定义为委外配置。迁移不得暗中任选其一。

## 事务、锁与投影边界

### 单一锁序

所有写路径使用以下全局顺序：

1. 发起动作自己的单据头（例如发货/入库头）；
2. 涉及的订单头，UUID 升序 `FOR UPDATE`；
3. 本次读取的报价头或 BOM 头（只在派生/复核/快照时，升序并持足以阻止并发修改/删除的锁）；
4. 订单行，UUID 升序 `FOR UPDATE`；
5. 发料清单行，UUID 升序 `FOR UPDATE`；
6. 履约需求行，UUID 升序 `FOR UPDATE`；
7. 后续库存/总账自身的锁。

订单的行、清单 CRUD 也必须先锁父订单，再重读并验证仍为 DRAFT。订单 audit/close/void/update/
delete 先锁订单头。父订单锁是聚合写串行点；不要仅依赖动作前的普通读取。

旧发货/入库/委外实现存在 `order item → order head` 的顺序，与订单编辑的
`order head → item` 相反。Go 迁移必须修正：跨订单履约单先用不加锁查询收集父订单 ID，
排序锁订单头，再排序锁行并复核 parent/状态/公司/对手/币种。不得照抄旧锁序。

常规行保存和订单审核在持有订单头锁后调用报价 Module 的 transaction-aware
`ResolveForOrder(ctx, tx, side, input)`。该方法锁报价头、重读报价行/档并返回不可变取价结果。
报价作废只锁报价头，不反向锁订单，因此不会形成环；它会与正在取价或审核的订单串行。
订单 Module 不应直接复制报价有效性和阶梯算法。

采购审核必须先按 `demand_line_id` 汇总本订单 `base_qty`，再逐需求行锁定和校验：
需求单已确认且未关闭/作废、行未完成、公司/物料一致、普通采购=BUY、委外=OUTSOURCE，并满足
`ordered + 本单合计 <= base × (1 + demand_overorder_ratio)`。成功后同事务累加；
作废同事务扣回。逐订单行校验会漏掉“同单多行引用同一需求行”的合计超量。

### 投影写所有权

`shipped_qty`、`received_qty`、`issued_qty`、需求的 `ordered_qty/received_qty` 都是
物化投影，不属于 Create/Update 输入，也不暴露通用 `AdjustQty(delta)`。

后续收发货 Module 应在自己的审核/作废事务中调用订单 Module 的语义化内部 Interface：

```go
PostFulfillment(ctx, tx, side, FulfillmentInput) error
ReverseFulfillment(ctx, tx, side, FulfillmentInput) error
PostOutsourcedIssue(ctx, tx, IssueInput) error
ReverseOutsourcedIssue(ctx, tx, IssueInput) error
```

`PostFulfillment` 自己读当前容差、执行上述锁序、要求订单 AUDITED、聚合同一订单行、校验超发/
超收并更新订单投影；采购侧同时更新需求 `received_qty`。`Reverse*` 允许为下游作废回滚，但
必须保证投影不为负。动作幂等性由下游单据状态转换保证，订单投影方法仍应在同一事务重读状态。
关闭订单只阻止新的 `Post*`；既有下游作废必须仍可 `Reverse*`。

不要为本地 PostgreSQL 造 repository port 或 fake projection store。PG 是
local-substitutable，实现测试直接跑真实 PG。上面是跨 Module 的内部 Seam，不是为了测试而
暴露的 Adapter。需求 Module 尚未迁移时，可先把需求 SQL 收在订单 Module 的
`demand_projection.go`；需求 Module 出现后改为接收同一 `pgx.Tx` 的具体调用，不预造只有一个
实现的 Go interface。

## package 与 sqlc Seam

推荐文件布局：

```text
server/internal/domain/trading/order/
  types.go service.go spec.go
  head.go item.go pricing.go
  purchase.go outsourcing.go demand_projection.go
  projection.go query.go meta.go
  postgres_test.go meta_test.go
server/db/queries/trading_order.sql
```

- `spec.go` 只保存受控静态差异：表名、权限、编号资源、允许对手、非常规类型/设置键、
  客户料闸、投影列。业务步骤不能变成几十个 bool 回调。
- 固定锁读、写入、聚合、存在性检查使用 sqlc；销售/采购分别写命名 SQL，生成不同 row 后由
  Module 内部 mapper 收敛。sqlc 不能参数化表名，禁止拼客户端标识符。
- 带动态筛选/排序的列表可沿用报价的 `filterbuild` + 受控 side SQL 模板；只在查询层动态。
- `dbgen` 行类型不穿出 Module Interface；事务由 Module 开启并持有，固定 SQL 接受同一个
  `pgx.Tx`。
- 附件同步直接在订单事务内写 `sys_attachment`；不要绕 HTTP 文件 Interface，也不要把附件
  留到提交后补偿。
- 收发货历史 `scm_order_flow_item` 是独立只读模型：订单 Module 可提供列表查询，但不拥有
  UNION 各臂的写入。

Deletion test：若删掉 `trading/order`，handler 不应还剩报价复核、金额计算、需求占用或履约
投影算法；若这些仍散落在 sales/purchase handler，Module 仍然太浅。

## 测试矩阵

所有事务和并发用真实 PostgreSQL、仅从 Module Interface 测；纯函数测试只覆盖金额舍入、
单位折算和 BOM 数学。共享用例按 `Side` 参数化，真实变体单列。

| 组 | 销售与采购共享断言 | 变体断言 |
|---|---|---|
| 生命周期 | 默认值/自动与手工编号/唯一；空单不能 audit；草稿可改删；AUDITED 后锁死；close/void 终态 | purchase `is_outsourced` 默认 false 且不可变 |
| 权限范围 | 无权限拒绝；公司范围越权表现为 not found；空公司范围 fail closed；子资源复用父权限 | 对手枚举分别限制 |
| 双币金额 | 本币=1；外币缺/负汇率失败；金额链舍入；改汇率全行和总额原子重算；有行后关键头冻结 | — |
| 行与快照 | qty/price/tax/unit；base_qty；保存重拍五列；图纸复制/刷新/删行/删头；写失败附件不漂移 | 销售客户料闸；采购不闸 |
| 报价 | fixed/tiered/低于首档；头匹配；日期；报价未审核/作废；用户材料/单位/价被覆盖；税率显式覆盖；audit 再复核 | sales/purchase 各自报价表；委外常规仍取加工费报价 |
| 非常规 | 禁挂报价；按 raw qty 卡当前 setting；保存后 setting 收紧导致 audit 失败 | SAMPLE vs SPOT |
| 需求 | — | 池过滤/200 上限/权限；BUY/OUTSOURCE；同需求多行先汇总；audit 加、void 减、close 不减；物料/公司/状态漂移复核 |
| 委外 | — | BOM 必须匹配成品、删除 SET NULL；发料/副产物 CRUD/单位/级联；BOM 快照公式、改 qty/BOM 不回溯；issued 仅内部可写 |
| 下游阻挡 | 已审核未作废下游存在时订单 void 失败；close 后拒新履约 | 发货；普通/委外入库 |
| 投影 | Post 聚合同一行并按容差；Reverse 回滚且不得负数；关闭后可回滚旧履约 | shipped；received + demand received；issued 可超发但投影不得负 |
| 并发 | 双 audit 仅一成功且一条审计；行编辑 vs audit 串行；close vs Post 串行；报价 void vs 行保存/audit 串行 | 两采购订单并发占同需求行不超容差 |
| 死锁回归 | 多订单履约以相反输入顺序并发，无死锁；结果满足投影和状态不变量 | 委外发料多清单行同测 |

必须额外做投影对账断言：订单行投影等于所有已审核未作废下游事实之和；需求 `ordered_qty`
等于已审核未作废采购订单行之和，需求 `received_qty` 等于有效采购/委外入库事实之和。

## 避免浅 port 与重复实现

- 不建 `sales/order` 与 `purchase/order` 两个复制包；真实差异不足以抵消两套状态机的漂移。
- 不抽“万能 Document CRUD”泛型；报价、订单、履约的状态与副作用不同，泛化会把规则推回调用方。
- 不让 handler 组合 `LockOrder`、`ValidateQuote`、`UpdateProjection` 等细粒度步骤；Interface
  应表达完整业务动作并拥有事务。
- 不复制 quotation 的固定/阶梯取价；加 transaction-aware `ResolveForOrder` 内部 Seam。
- 不把 `shipped/received/issued/ordered` 放进通用 update DTO，也不公开 signed delta。
- 不为 sqlc 生成类型写 repository Adapter；测试真实 PG，内部 mapper 已足够。
- 不因采购多字段就在共享流程堆条件分支；采购需求、委外清单各自放专用实现文件，Head/Item
  的共享编排只调用明确步骤。

## 勘察依据

- `backend/apps/synie_core/lib/synie_core/sales/order.ex`、`order_item.ex`
- `backend/apps/synie_core/lib/synie_core/purchase/order.ex`、`order_item.ex`、
  `order_item_material.ex`、`order_item_byproduct.ex`
- 对应旧 `order_test.exs`、`order_outsourced_test.exs`
- 旧 `sales/delivery.ex`、`purchase/receipt.ex`、`purchase/outsourced_issue.ex`、
  `purchase/outsourced_receipt.ex`
- 现有 `server/internal/domain/trading/quotation`、`server/db/queries/trading_quotation.sql`
- `CONTEXT.md`、`docs/adr/2026-07-20-purchase-line.md`、
  `docs/adr/2026-07-24-outsourced-purchase.md`、
  `docs/adr/2026-07-25-demand-purchase-linkage.md`
