/**
 * 订单履约投影：审核发货/入库时累加 shipped_qty/received_qty，作废回滚；含超发/超收容差。
 * 委外发料：累加 pur_order_item_material.issued_qty（超发不硬拦）。
 * 调用方持有 trx；本模块不自起事务。
 *
 * 实现见 platform/posting/controlled-projection（W0 T0.3）；
 * 此处注入 afterAdjust → recomputeDemandItemProjections（静态 import，解环）。
 */
import type { DbHandle } from '~/db/tx.ts'
import { recomputeDemandItemProjections } from '~/modules/manufacturing/arrangement.ts'
import {
  maxFulfillableQty,
  postFulfillment as postFulfillmentCore,
  postOutsourcedIssue,
  reverseFulfillment as reverseFulfillmentCore,
  reverseOutsourcedIssue,
  type AfterAdjust,
  type ControlledProjectionOptions,
  type FulfillmentInput,
  type FulfillmentLine,
  type OutsourcedIssueInput,
  type OutsourcedIssueLine,
  type TradingSide,
} from '~/platform/posting/controlled-projection.ts'

export type {
  FulfillmentInput,
  FulfillmentLine,
  OutsourcedIssueInput,
  OutsourcedIssueLine,
}
export { maxFulfillableQty, postOutsourcedIssue, reverseOutsourcedIssue }

/** 采购入库同步需求已收后重算安排投影（rowId = demand_item.id） */
const afterDemandReceived: AfterAdjust = async (db, { rowId }) => {
  await recomputeDemandItemProjections(db, rowId)
}

const demandOpts: ControlledProjectionOptions = { afterAdjust: afterDemandReceived }

/**
 * `skipDemandChain`：采购退货回减/回滚已收数量时传 true——
 * 需求行已完成/已收不随退货反转（ADR 2026-08-09），只动订单条目投影。
 */
export async function postFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
  opts?: { skipDemandChain?: boolean },
): Promise<void> {
  return postFulfillmentCore(db, side, input, { ...demandOpts, ...opts })
}

export async function reverseFulfillment(
  db: DbHandle,
  side: TradingSide,
  input: FulfillmentInput,
  opts?: { skipDemandChain?: boolean },
): Promise<void> {
  return reverseFulfillmentCore(db, side, input, { ...demandOpts, ...opts })
}
