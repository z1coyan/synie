import type { Actor } from '~/platform/authz/actor.ts'
import {
  createSideFulfillment,
  createSideOrder,
  createSideQuotation,
  createSideReconciliation,
} from './chains.ts'
import type { MasterData, SeedCtx } from './helpers.ts'
import type { PurchaseResult, SampleDataDeps } from './types.ts'

export async function seedPurchase(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<PurchaseResult> {
  const result: PurchaseResult = {
    quotations: [],
    orders: [],
    receipts: [],
    reconciliations: [],
    confirmedReconciliation: '',
    confirmedBaseGrossTotal: '0.00',
    quotationItems: {},
    orderItems: {},
    receiptItems: {},
  }

  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S01!.id,
      88,
      90,
      '到厂价含税,运费另计',
      true,
      [
        { key: 'copper_rod', price: '52.00' },
        { key: 'copper_bar', price: '36.80' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.pq1 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S04!.id,
      72,
      90,
      '含运费到厂',
      true,
      [
        { key: 'steel_sheet', price: '85.00' },
        { key: 'stamped_part', price: '6.50' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.pq2 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S05!.id,
      50,
      60,
      '含税,款到发货',
      true,
      [
        { key: 'abs_pellet', price: '14.20' },
        { key: 'stretch_film', price: '28.00' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.pq3 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S02!.id,
      30,
      45,
      '含税,月结 30 天',
      true,
      [{ key: 'screw', price: '0.045' }],
    )
    result.quotations.push(id)
    result.quotationItems.pq4 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S06!.id,
      6,
      30,
      null,
      false,
      [{ key: 'carton', price: '3.80' }],
    )
    result.quotations.push(id)
    result.quotationItems.pq5 = byKey
  }

  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S01!.id,
      75,
      '初始化示例采购订单(已审核)',
      true,
      [
        { key: 'copper_rod', quotationItemId: result.quotationItems.pq1!.copper_rod!, qty: 500 },
        { key: 'copper_bar', quotationItemId: result.quotationItems.pq1!.copper_bar!, qty: 200 },
      ],
    )
    result.orders.push(id)
    result.orderItems.po1 = byIdx
  }
  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S04!.id,
      60,
      '初始化示例采购订单(已审核)',
      true,
      [
        { key: 'steel_sheet', quotationItemId: result.quotationItems.pq2!.steel_sheet!, qty: 400 },
        { key: 'stamped_part', quotationItemId: result.quotationItems.pq2!.stamped_part!, qty: 600 },
      ],
    )
    result.orders.push(id)
    result.orderItems.po2 = byIdx
  }
  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S05!.id,
      35,
      '初始化示例采购订单(已审核)',
      true,
      [
        { key: 'abs_pellet', quotationItemId: result.quotationItems.pq3!.abs_pellet!, qty: 800 },
        { key: 'stretch_film', quotationItemId: result.quotationItems.pq3!.stretch_film!, qty: 200 },
      ],
    )
    result.orders.push(id)
    result.orderItems.po3 = byIdx
  }
  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'purchase',
      md.suppliers.S02!.id,
      8,
      '初始化示例采购订单(草稿,可改后审核)',
      false,
      [{ key: 'screw', quotationItemId: result.quotationItems.pq4!.screw!, qty: 5000 }],
    )
    result.orders.push(id)
    result.orderItems.po4 = byIdx
  }

  {
    const { byIdx, id } = await createSideFulfillment(
      deps,
      actor,
      sc,
      'purchase',
      md.suppliers.S01!.id,
      70,
      sc.accounts.inventory,
      sc.accounts.unbilledAP,
      [
        { orderItemId: result.orderItems.po1![0]!, qty: 500 },
        { orderItemId: result.orderItems.po1![1]!, qty: 200 },
      ],
    )
    result.receipts.push(id)
    result.receiptItems.pr1 = byIdx
  }
  {
    const { byIdx, id } = await createSideFulfillment(
      deps,
      actor,
      sc,
      'purchase',
      md.suppliers.S04!.id,
      45,
      sc.accounts.inventory,
      sc.accounts.unbilledAP,
      [
        { orderItemId: result.orderItems.po2![0]!, qty: 400 },
        { orderItemId: result.orderItems.po2![1]!, qty: 600 },
      ],
    )
    result.receipts.push(id)
    result.receiptItems.pr2 = byIdx
  }
  {
    const { byIdx, id } = await createSideFulfillment(
      deps,
      actor,
      sc,
      'purchase',
      md.suppliers.S05!.id,
      25,
      sc.accounts.inventory,
      sc.accounts.unbilledAP,
      [
        { orderItemId: result.orderItems.po3![0]!, qty: 800 },
        { orderItemId: result.orderItems.po3![1]!, qty: 150 },
      ],
    )
    result.receipts.push(id)
    result.receiptItems.pr3 = byIdx
  }

  {
    const r = await createSideReconciliation(
      deps,
      actor,
      sc,
      'purchase',
      md.suppliers.S01!.id,
      '初始化示例采购对账(已确认)',
      true,
      [
        { sourceItemId: result.receiptItems.pr1![0]!, qty: 500, kind: 'receipt' },
        { sourceItemId: result.receiptItems.pr1![1]!, qty: 200, kind: 'receipt' },
      ],
    )
    result.reconciliations.push(r.id)
    result.confirmedReconciliation = r.id
    result.confirmedBaseGrossTotal = r.baseGrossTotal
  }
  {
    const r = await createSideReconciliation(
      deps,
      actor,
      sc,
      'purchase',
      md.suppliers.S04!.id,
      '初始化示例采购对账(草稿)',
      false,
      [
        { sourceItemId: result.receiptItems.pr2![0]!, qty: 400, kind: 'receipt' },
        { sourceItemId: result.receiptItems.pr2![1]!, qty: 300, kind: 'receipt' },
      ],
    )
    result.reconciliations.push(r.id)
  }

  return result
}
