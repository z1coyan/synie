# 销售订单条目快照：物料信息与图纸按行保存时冻结

订单条目展示物料信息改为快照口径：行保存（create/update）时把物料编号/名称/规格/客户料号与单位名称写入 `sal_order_item` 物理列（`writable? false`，照 `amount` 先例由 change 写入），并把物料当前图纸的 sys_file 挂接复制到行（owner `sal_order_item`、category `drawing`，整删整建）；审核锁行即冻结，主数据后续变更不回溯。图纸用挂接复制而非字节复制——文件字节不可变、有挂接不可删（AttachmentGuard），引用即永恒，零存储放大；JSONB 裸引用被否（删除守卫只数 attachment 会悬空，展示/预览/授权机制全不可用）。存量行迁移时按当前主数据回填，口径为迁移时点。与 ADR 2026-07-17-sales-order-item-view 的分工：订单自身事实（日期/状态/对手）走 live calculation，外部主数据的引用口径走快照。删除链路有坑：订单删行是 DB 级联、Ash destroy 钩子不触发，订单/行删除必须显式清理行的图纸挂接，否则文件被删除守卫永久锁死。
