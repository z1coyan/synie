import type { Actor } from '~/platform/authz/actor.ts'
import {
  createSideFulfillment,
  createSideOrder,
  createSideQuotation,
  createSideReconciliation,
} from './chains.ts'
import type { MasterData, SeedCtx } from './helpers.ts'
import type { SalesResult, SampleDataDeps } from './types.ts'

export async function seedSales(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<SalesResult> {
  const result: SalesResult = {
    quotations: [],
    orders: [],
    deliveries: [],
    reconciliations: [],
    confirmedReconciliation: '',
    confirmedBaseGrossTotal: '0.00',
    quotationItems: {},
    orderItems: {},
    deliveryItems: {},
  }

  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C01!.id,
      88,
      90,
      '示例:含税交货,账期月结 30 天',
      true,
      [
        { key: 'box_shell', price: '128.00' },
        { key: 'busbar', price: '86.50' },
        { key: 'terminal_block', price: '2.35' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.sq1 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C02!.id,
      75,
      90,
      '含税交货,款到发货',
      true,
      [
        { key: 'mount_plate', price: '45.00' },
        { key: 'terminal_block', price: '2.40' },
        { key: 'copper_terminal', price: '1.20' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.sq2 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C03!.id,
      40,
      60,
      '含税交货',
      true,
      [
        { key: 'terminal_assy', price: '32.00' },
        { key: 'insul_sleeve', price: '18.50' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.sq3 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C05!.id,
      15,
      45,
      '含税交货',
      true,
      [
        { key: 'terminal_block', price: '2.50' },
        { key: 'copper_terminal', price: '1.30' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.sq4 = byKey
  }
  {
    const { byKey, id } = await createSideQuotation(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C04!.id,
      5,
      25,
      null,
      false,
      [
        { key: 'rail', price: '22.00' },
        { key: 'copper_terminal', price: '1.25' },
      ],
    )
    result.quotations.push(id)
    result.quotationItems.sq5 = byKey
  }

  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C01!.id,
      70,
      '初始化示例销售订单(已审核,两单发完)',
      true,
      [
        { key: 'box_shell', quotationItemId: result.quotationItems.sq1!.box_shell!, qty: 50 },
        { key: 'busbar', quotationItemId: result.quotationItems.sq1!.busbar!, qty: 20 },
      ],
    )
    result.orders.push(id)
    result.orderItems.so1 = byIdx
  }
  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C02!.id,
      55,
      '初始化示例销售订单(已审核)',
      true,
      [
        { key: 'mount_plate', quotationItemId: result.quotationItems.sq2!.mount_plate!, qty: 25 },
        {
          key: 'terminal_block',
          quotationItemId: result.quotationItems.sq2!.terminal_block!,
          qty: 500,
        },
        {
          key: 'copper_terminal',
          quotationItemId: result.quotationItems.sq2!.copper_terminal!,
          qty: 800,
        },
      ],
    )
    result.orders.push(id)
    result.orderItems.so2 = byIdx
  }
  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C03!.id,
      20,
      '初始化示例销售订单(已审核,待发货)',
      true,
      [
        {
          key: 'terminal_assy',
          quotationItemId: result.quotationItems.sq3!.terminal_assy!,
          qty: 40,
        },
      ],
    )
    result.orders.push(id)
    result.orderItems.so3 = byIdx
  }
  {
    const { byIdx, id } = await createSideOrder(
      deps,
      actor,
      sc,
      md,
      'sales',
      md.customers.C01!.id,
      3,
      '初始化示例销售订单(草稿,可改后审核)',
      false,
      [{ key: 'busbar', quotationItemId: result.quotationItems.sq1!.busbar!, qty: 10 }],
    )
    result.orders.push(id)
    result.orderItems.so4 = byIdx
  }

  {
    const { byIdx, id } = await createSideFulfillment(
      deps,
      actor,
      sc,
      'sales',
      md.customers.C01!.id,
      60,
      sc.accounts.unbilledAR,
      sc.accounts.revenue,
      [
        { orderItemId: result.orderItems.so1![0]!, qty: 30 },
        { orderItemId: result.orderItems.so1![1]!, qty: 20 },
      ],
    )
    result.deliveries.push(id)
    result.deliveryItems.sd1 = byIdx
  }
  {
    const { byIdx, id } = await createSideFulfillment(
      deps,
      actor,
      sc,
      'sales',
      md.customers.C01!.id,
      30,
      sc.accounts.unbilledAR,
      sc.accounts.revenue,
      [{ orderItemId: result.orderItems.so1![0]!, qty: 20 }],
    )
    result.deliveries.push(id)
    result.deliveryItems.sd2 = byIdx
  }
  {
    const { byIdx, id } = await createSideFulfillment(
      deps,
      actor,
      sc,
      'sales',
      md.customers.C02!.id,
      12,
      sc.accounts.unbilledAR,
      sc.accounts.revenue,
      [
        { orderItemId: result.orderItems.so2![0]!, qty: 25 },
        { orderItemId: result.orderItems.so2![1]!, qty: 500 },
        { orderItemId: result.orderItems.so2![2]!, qty: 800 },
      ],
    )
    result.deliveries.push(id)
    result.deliveryItems.sd3 = byIdx
  }

  {
    const r = await createSideReconciliation(
      deps,
      actor,
      sc,
      'sales',
      md.customers.C01!.id,
      '初始化示例销售对账(已确认)',
      true,
      [
        { sourceItemId: result.deliveryItems.sd1![0]!, qty: 30, kind: 'delivery' },
        { sourceItemId: result.deliveryItems.sd1![1]!, qty: 20, kind: 'delivery' },
        { sourceItemId: result.deliveryItems.sd2![0]!, qty: 20, kind: 'delivery' },
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
      'sales',
      md.customers.C02!.id,
      '初始化示例销售对账(草稿)',
      false,
      [
        { sourceItemId: result.deliveryItems.sd3![0]!, qty: 25, kind: 'delivery' },
        { sourceItemId: result.deliveryItems.sd3![1]!, qty: 300, kind: 'delivery' },
        { sourceItemId: result.deliveryItems.sd3![2]!, qty: 800, kind: 'delivery' },
      ],
    )
    result.reconciliations.push(r.id)
  }

  return result
}
