/**
 * 履约审核/作废 effect：状态转移外壳（锁行/闸门/盖章 UPDATE/审计/重载）收编进
 * 内核 workflow transition（D7 收尾），本文件只剩领域效果函数。
 * 聚合草稿不进本路径；装箱相等与金额分摊在 collect 内。
 */
import { decimal, roundAmount } from '@synie/shared'
import { toDateOnly } from '~/db/dates.ts'
import type { TrxHandle } from '~/db/tx.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { accountCurrencies } from '~/platform/posting/account-currency.ts'
import { lowerParty as lowerPartyType } from '~/platform/posting/text.ts'
import { postFulfillment, reverseFulfillment } from '../order/projection.ts'
import {
  loadActionItems,
  validateHeadRefs,
  validateHeadShape,
  validatePackEquality,
} from './domain.ts'
import type { FulfillmentSideSpec } from './spec.ts'
import type { FulfillmentHead } from './types.ts'

interface Engines {
  inventory: Pick<InventoryEngine, 'post' | 'cancel'>
  gl: Pick<GlEngine, 'post' | 'cancel'>
}

/**
 * 审核效果：头校验 → 条目装载（至少一条；销售侧装箱相等）→ 订单投影 →
 * 库存分录 → 金额>0 时 GL（零金额跳总账）。posting_date 经返回值并入状态翻转 UPDATE。
 * postingDateOverride 由转移 input.postingDate 传入（照 bill-service 先例）。
 */
export async function effectAuditHead(
  trx: TrxHandle,
  engines: Engines,
  spec: FulfillmentSideSpec,
  before: FulfillmentHead,
  postingDateOverride?: string | null,
): Promise<{ posting_date: string | null }> {
  validateHeadShape(spec, before)
  await validateHeadRefs(trx, spec, before)

  const items = await loadActionItems(trx, spec, before.id)
  if (items.length === 0) throw new ApiError('conflict', '审核前必须至少填写一条履约条目')
  if (spec.side === 'sales') await validatePackEquality(trx, before.id, items)

  const projectionLines = items.map((i) => ({
    orderItemId: i.orderItemId,
    baseQty: i.baseQty,
  }))
  const stockLines: StockLine[] = items
    .filter((i) => i.materialType === 'STOCK')
    .map((i) => {
      if (!i.warehouseId) {
        throw new ApiError(
          'conflict',
          `物料 ${i.materialCode} ${i.materialName} 已转为库存类,行仓必填后才可审核`,
        )
      }
      return {
        warehouseId: i.warehouseId,
        materialId: i.materialId,
        quantity: decimal(i.baseQty),
        direction: (spec.stockDirection < 0 ? 'out' : 'in') as 'in' | 'out',
        remarks: before.remarks,
      }
    })
  let amount = decimal(0)
  for (const item of items) {
    if (!decimal(item.orderBaseQty).isZero()) {
      amount = amount.add(
        decimal(item.orderBaseAmount)
          .mul(decimal(item.baseQty))
          .div(decimal(item.orderBaseQty)),
      )
    }
  }

  await postFulfillment(trx, spec.side, {
    companyId: before.companyId,
    partyType: before.partyType,
    partyId: before.partyId,
    lines: projectionLines,
  })

  if (stockLines.length > 0) {
    await engines.inventory.post(
      trx,
      {
        type: spec.voucherType,
        id: before.id,
        no: before.no,
        companyId: before.companyId,
        postingDate: before.documentDate,
      },
      stockLines,
    )
  }

  const glAmount = decimal(roundAmount(amount))
  let postingDate = before.postingDate ?? before.documentDate
  if (postingDateOverride) postingDate = toDateOnly(postingDateOverride)
  if (glAmount.gt(0)) {
    if (!postingDate) {
      throw ApiError.validation('审核参数不合法', { postingDate: ['有金额过账时必填'] })
    }
    const currencies = await accountCurrencies(trx, before.debitAccountId, before.creditAccountId)
    const debit: GlEntry = {
      accountId: before.debitAccountId,
      currencyId: currencies.debit,
      debit: glAmount,
      credit: decimal(0),
    }
    const credit: GlEntry = {
      accountId: before.creditAccountId,
      currencyId: currencies.credit,
      debit: decimal(0),
      credit: glAmount,
    }
    if (spec.side === 'sales') {
      debit.partyType = lowerPartyType(before.partyType)
      debit.partyId = before.partyId
    } else {
      credit.partyType = lowerPartyType(before.partyType)
      credit.partyId = before.partyId
    }
    await engines.gl.post(
      trx,
      {
        type: spec.voucherType,
        id: before.id,
        no: before.no,
        companyId: before.companyId,
        postingDate,
      },
      [debit, credit],
    )
  }
  return { posting_date: postingDate }
}

/** 作废效果：已对账条目拦截 → 订单投影回滚 → 库存/总账分录作废 */
export async function effectVoidHead(
  trx: TrxHandle,
  engines: Engines,
  spec: FulfillmentSideSpec,
  before: FulfillmentHead,
): Promise<void> {
  const items = await loadActionItems(trx, spec, before.id)
  for (const item of items) {
    if (decimal(item.reconciledQty).gt(0)) {
      throw new ApiError('conflict', '存在已对账履约条目,不可作废')
    }
  }
  const lines = items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty }))

  await reverseFulfillment(trx, spec.side, {
    companyId: before.companyId,
    partyType: before.partyType,
    partyId: before.partyId,
    lines,
  })
  await engines.inventory.cancel(trx, { type: spec.voucherType, id: before.id })
  await engines.gl.cancel(trx, { type: spec.voucherType, id: before.id })
}
