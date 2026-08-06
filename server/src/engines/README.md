# engines/ — 事实引擎

深模块，唯一写分录入口（KD15/KD19/KD26）：

- `gl/`：`createGlEngine()` → `post` / `cancel` / `reverse`
  （配平/科目/往来对手/红冲；参考 `server-go/internal/engines/gl`）
  `validateEntries` 为测试出口，不挂 interface
- `inventory/`：`createInventoryEngine()` → `post` / `cancel` / `balance`
  （（仓×物料）advisory lock + 叶子仓 + 负库存；`StockLine.direction` 表达出入）

纪律：

- 单据禁止直写分录表
- 引擎禁止自起事务（写方法只收 `TrxHandle`，由调用方 `withTx` 传入）
- 引擎不得 `import modules/*`
- 金额/数量走 `@synie/shared` decimal（interface 层禁止 number）
- 业务日 `toDateOnly` 单点在 `~/db/dates.ts`

