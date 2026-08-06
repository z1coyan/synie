# 销售订单条目视图的头字段走 calculation 而非冗余列

销售订单列表页改为「订单条目（默认）/订单」双 tab 子路由；条目视图需要展示订单头字段（订单日期/对手/状态），这些字段不落 `sal_order_item` 物理列，而是在 OrderItem 上定义沿 `belongs_to :order` 取值的 expr calculation，由 GridMeta 新增的 opt-in 机制（资源声明 `grid_calculations/0`，照 `grid_actions/0`、`grid_capabilities/0` 先例）反射成列，对手字段复用 poly_refs 多态 fk 机制。冗余物理列方案被否：草稿期改头与审核/关闭/作废多处写点都要级联同步可变字段，长期一致性税高于计算列的代价（计算列可能不可筛选/排序，但条目视图的核心筛选是物料与订单号，不依赖头字段筛选）。条目视图不提供行级写操作，编辑永远回到所属订单抽屉进行，与「仅草稿订单可编辑条目」的后端约束对齐。
