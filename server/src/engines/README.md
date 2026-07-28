# engines/ — 事实引擎

深模块，唯一写分录入口（KD15/KD19/KD26）：

- `gl/`：`createGlEngine()` → `post` / `cancel` / `reverse` / `validateEntries`
  （配平/科目/往来对手/红冲；参考 `server-go/internal/engines/gl`）
- `inventory/`：`createInventoryEngine()` → `post` / `cancel` / `balance`
  （（仓×物料）advisory lock + 叶子仓 + 负库存；参考 `server-go` 库存域 stock）

纪律：

- 单据禁止直写分录表
- 引擎禁止自起事务（`DbHandle` 由调用方 `withTx` 传入）
- 引擎不得 `import modules/*`
- 金额/数量走 `@synie/shared` decimal

实现工单：`.scratch/ts-backend-rewrite/issues/03-engines.md`
