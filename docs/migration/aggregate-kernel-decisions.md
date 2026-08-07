# 聚合单据内核·行为变更与设计决策日志

迁移分支：`feat/aggregate-kernel`（由 `feat/aggregate-kernel-w0` 改名延续；基线 `main` @ 638235fb；计划见 `.scratch/aggregate-kernel/plan.md` / `/tmp/aggregate-kernel-plan-20260807.md`）。

铁律：红测试 = 显式决策点；每一条有意的行为变更在此记一行（资源/旧行为/新行为/理由）。
报错文案与 wire 字节不变——调用点原有 code/status/字段键/中文文案逐字保留（用 label/字段参数化，不要统一成一种文案）。
禁止为绿测而改文案或删测。

| 日期 | 决策 | 内容 |
|------|------|------|
| 2026-08-07 | D10 | 三个领域基元落 `platform/posting/` 扩容；不新建 `platform/domain-primitives/` |
| 2026-08-07 | D11 | 受控投影累加器收 `afterAdjust` 回调，去掉对 manufacturing/arrangement 的动态 import |

---

## D10 · 领域基元落点（W0 首日定名）

**定案**：扩容既有 `server/src/platform/posting/`，**不**新建 `platform/domain-primitives/` 顶层概念。

**理由**（与 plan 倾向一致，无强偏离理由）：

1. **先例**：`posting` 已是跨域单据共享层（过账骨架 `skeleton.ts` / 形状登记 `shapes.ts`；骨架内 `accountCurrencies` 已在此收口科目币种 SQL）。
2. **铁律**：platform 不 import domain（`docs/系统架构/模块结构.md`）。三基元自带 SQL（对齐 `numbering` 对 `sys_*` 表先例），禁止 `import '~/modules/*'`。
3. **不新增顶层概念**：W0 只是把 trading / inventory / manufacturing 里重复的「单据写路径基元」上提；`domain-primitives/` 会多一层目录语义，与现有 `posting` 边界重叠。

### 定案路径

| 基元 | 路径 | 吸收来源（W0 机械替换，本决策不改行为） |
|------|------|------------------------------------------|
| 物料口径 | `platform/posting/material-qty.ts` | `trading/common.ts` base_qty/物料快照；`inventory/helpers.ts` `projectStockItem`；`manufacturing/helpers.ts` `deriveItemProjection`（同一 join、6 位小数、报错文案按调用点 label 参数化逐字保留） |
| 仓库校验 | `platform/posting/warehouse.ts` | 叶子/同司/启用/外协绑定等 6 份实现、~20 调用点（`validateLeafWarehouse` / `validateWarehouse` 等） |
| 受控投影 | `platform/posting/controlled-projection.ts` | 5 个增量累加器：已发 / 已收 / 已对账 / 已安排相关 / 工单入库；排序锁、`FOR UPDATE`、负数守卫、容差闸门内置。**重算式**投影（`recomputeDemandItemProjections`）保持独立、不并入累加器 |

杂项（plan T0.4，同波可选落地）：

| 工具 | 路径 | 说明 |
|------|------|------|
| `runeLen` / `withIndexedFields` | `platform/posting/text.ts` | 不放进 `platform/standard/fields.ts`：后者专管 ResourceMeta wire/db 值转换，职责不同 |
| `lowerParty` | `platform/posting/text.ts` | 与 skeleton 内 `lowerPartyType` 同语义；调用点改静态 import 本 module |

**不做**：`platform/domain-primitives/`；platform 内任何对 `~/modules/*` 的静态或动态 import。

**与 plan 对照**：plan D10 标 `？`、倾向 `platform/posting/` 扩容——本表 ★ 定案采纳该倾向。

---

## D11 · 受控投影累加器循环依赖解法

**问题**：platform 若直接依赖「安排重算」，会违反 platform↛domain；今日以 3 处动态 import 绕环：

1. `modules/trading/order/projection.ts`（采购入库同步 `mfg_demand_item.received_qty` 后）
2. `modules/trading/order/service.ts`（订单条目挂钩/解钩 `mfg_demand_arrangement` 后）
3. `modules/manufacturing/output-service.ts`（工单 `received_base_qty` 更新后）

均 `await import('…/arrangement.ts')` 再调 `recomputeDemandItemProjections(db, demandItemId)`。

**定案**：累加器 API 收 **`afterAdjust`** 可选回调；由组合根 / 领域调用方注入安排重算。`controlled-projection.ts` **实现处不再知道 manufacturing**。

### `afterAdjust` 签名草图

```ts
import type { DbHandle } from '~/db/tx.ts'
import type { Decimal } from '@synie/shared'

/** 单行投影调整完成后的领域副作用（可选） */
export type AfterAdjust = (
  db: DbHandle,
  ctx: {
    /** 被锁并更新的投影行主键（订单条目 / 需求行 / 工单等） */
    rowId: string
    /** 调整后的投影数量 */
    next: Decimal
    /** +1 审核累加 / −1 作废回滚（与现有 direction 一致） */
    direction: 1 | -1
  },
) => Promise<void>

/** 受控投影描述符（草图；W0 实现时按 5 个累加器收口字段，可增不可改语义） */
export interface ControlledProjectionSpec {
  // table / column / 锁序 / 负数文案 / 容差 … 由实现定
  /**
   * 投影列 UPDATE 成功后、进入下一行之前调用。
   * 缺省 = 无副作用（如纯 shipped_qty / reconciled_qty）。
   * 需要倒写需求安排投影时由调用方注入 recompute。
   */
  afterAdjust?: AfterAdjust
}

// 调用方注入示例（领域侧静态 import，platform 零感知）：
// afterAdjust: async (db, { rowId }) => {
//   await recomputeDemandItemProjections(db, rowId)
// }
```

**注入点约定**：

- 履约已收→需求行：`adjustDemandReceived` 迁入累加器后，`afterAdjust` 在 `received_qty` 写成功后触发；`rowId` = `mfg_demand_item.id`。
- 工单入库投影：`updateWorkOrderProjection` 迁入后同理；`rowId` 取 `demandItemId`（重算键是需求行，不是工单 id——与现 `recomputeDemandItemProjections(db, order.demandItemId)` 一致）。
- 订单条目安排挂钩（`order/service.ts` 动态 import）：不属「单列增量累加器」核心环，但同纪律——**静态** import `arrangement.ts`，或抽本地 `onDemandTouched(db, lineId)` 闭包；禁止再 `await import(...)` 绕环。W0 替换时二选一，行为字节不变。

**明确不并**：`recomputeDemandItemProjections` 本身仍属 manufacturing（从安排事实全量重算 `arranged_qty`/`completed_qty`/行状态），**不**搬进 `controlled-projection.ts`。

**与 plan 对照**：plan D11 标 `？`、建议 `afterAdjust` 由组合根注入——本表 ★ 定案采纳；签名在 plan 一句建议之上补 `ctx.next` / `ctx.direction`，便于日后审计钩，调用方可只解构 `rowId`。

---

## 行为变更表（有意变更时续记）

| 资源 | 旧行为 | 新行为 | 理由 |
|------|--------|--------|------|
| — | — | — | W0 定名阶段无行为变更；实现波次若红测暴露差异，先记本表再改 |

---

## 非目标（本日志边界）

- 不做 W1+（内核 `*InTx`、`aggregate.ts`、资源迁移）。
- 不动 `engines/gl` | `engines/inventory` interface。
- 不做路由词表收口；wire URL/DTO/错误码字节冻结。
