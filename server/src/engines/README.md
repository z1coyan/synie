# engines/ — 事实引擎（骨架）

深模块，唯一写分录入口（KD15/KD19/KD26）：
- `gl/`：总账引擎 post/cancel/reverse + 配平/科目/对手校验（参考 server-go/internal/engines/gl）
- `inventory/`：库存引擎 post/cancel + （仓×物料）advisory lock + 负库存校验
  （参考 server-go 库存域内引擎实现）

纪律：单据禁止直写分录表；引擎禁止自起事务（trx 由调用方传入）；引擎不得 import modules/*。
实现工单：`.scratch/ts-backend-rewrite/issues/03-engines.md`
