# ADR：总账分录来源单据多态引用

2026-07-12。分录上来源单据用多态字段（`voucher_type` / `voucher_id` / `voucher_no`），无真外键——来源类型开放、跨域单据统一追溯。

- 库存分录等后续事实表复用同一 poly-ref 形状。
- 展示与跳转依赖 type+id；编号冗余在 `voucher_no` 便于流水只读展示。
