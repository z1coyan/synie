/**
 * 委外发料/入库审核·作废 effect：原 posting skeleton 编排内联到 workflow 转移。
 * 聚合草稿不进本路径；三向收料（成品入/材料扣/副产物入）在 collect 内。
 */
import { decimal, roundAmount } from '@synie/shared'
import { toDateOnly } from '~/db/dates.ts'
import type { TrxHandle } from '~/db/tx.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { accountCurrencies } from '~/platform/posting/account-currency.ts'
import { lowerParty as lowerPartyType } from '~/platform/posting/text.ts'
import { validateEnabledLeafWarehouse, validateOutsourcedWarehouse } from '~/platform/posting/warehouse.ts'
import {
  postFulfillment,
  postOutsourcedIssue,
  reverseFulfillment,
  reverseOutsourcedIssue,
} from '../order/projection.ts'
import { wireRequiredDecimal } from '../common.ts'
import {
  deriveIssueItem,
  deriveReceiptItem,
  ISSUE_PREFIX,
  loadIssueActionItems,
  loadReceiptActionLines,
  RECEIPT_PREFIX,
  type IssueHead,
  type ReceiptHead,
} from './domain.ts'

function wq(v: string | ReturnType<typeof decimal>) {
  return wireRequiredDecimal(String(v))
}

export async function effectAuditIssue(
  trx: TrxHandle,
  inventory: Pick<InventoryEngine, 'post' | 'cancel'>,
  before: IssueHead,
): Promise<void> {
  const items = await loadIssueActionItems(trx, before.id)
  if (items.length === 0) {
    throw new ApiError('conflict', '委外发料单至少需要一条发料行')
  }
  const stockLines: StockLine[] = []
  const projection: Array<{ orderItemMaterialId: string; baseQty: string }> = []
  for (const item of items) {
    await deriveIssueItem(trx, before, {
      orderItemMaterialId: item.orderItemMaterialId,
      qty: decimal(item.qty),
      fromWarehouseId: item.fromWarehouseId,
      outsourcedWarehouseId: item.outsourcedWarehouseId,
      remarks: item.remarks,
    })
    projection.push({
      orderItemMaterialId: item.orderItemMaterialId,
      baseQty: item.baseQty,
    })
    stockLines.push(
      {
        warehouseId: item.fromWarehouseId,
        materialId: item.materialId,
        quantity: wq(item.baseQty),
        direction: 'out',
        remarks: item.remarks,
      },
      {
        warehouseId: item.outsourcedWarehouseId,
        materialId: item.materialId,
        quantity: wq(item.baseQty),
        direction: 'in',
        remarks: item.remarks,
      },
    )
  }
  if (stockLines.length > 0) {
    await inventory.post(
      trx,
      {
        type: ISSUE_PREFIX,
        id: before.id,
        no: before.issueNo,
        companyId: before.companyId,
        postingDate: before.issueDate,
      },
      stockLines,
    )
  }
  await postOutsourcedIssue(trx, {
    companyId: before.companyId,
    partyType: before.partyType,
    partyId: before.partyId,
    lines: projection,
  })
}

export async function effectVoidIssue(
  trx: TrxHandle,
  inventory: Pick<InventoryEngine, 'post' | 'cancel'>,
  before: IssueHead,
): Promise<void> {
  const items = await loadIssueActionItems(trx, before.id)
  await reverseOutsourcedIssue(trx, {
    companyId: before.companyId,
    partyType: before.partyType,
    partyId: before.partyId,
    lines: items.map((i) => ({
      orderItemMaterialId: i.orderItemMaterialId,
      baseQty: i.baseQty,
    })),
  })
  await inventory.cancel(trx, { type: ISSUE_PREFIX, id: before.id }, new Date())
}

export async function effectAuditReceipt(
  trx: TrxHandle,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
  before: ReceiptHead,
  postingDateOverride?: string | null,
): Promise<{ posting_date: string | null }> {
  const { items, materials, byproducts } = await loadReceiptActionLines(trx, before.id)
  if (items.length === 0) {
    throw new ApiError('conflict', '委外入库单至少需要一条成品行')
  }
  const stockLines: StockLine[] = []
  const projectionLines: Array<{ orderItemId: string; baseQty: string }> = []
  let amount = decimal(0)
  for (const item of items) {
    await deriveReceiptItem(
      trx,
      before,
      {
        qty: decimal(item.qty),
        orderItemId: item.orderItemId,
        unitId: item.unitId,
        warehouseId: item.warehouseId,
        remarks: item.remarks,
      },
      item.id,
    )
    projectionLines.push({ orderItemId: item.orderItemId, baseQty: item.baseQty })
    stockLines.push({
      warehouseId: item.warehouseId,
      materialId: item.materialId,
      quantity: wq(item.baseQty),
      direction: 'in',
      remarks: item.remarks,
    })
    if (decimal(item.orderBaseQty).gt(0)) {
      amount = amount.add(
        decimal(item.orderBaseAmount).mul(decimal(item.baseQty)).div(decimal(item.orderBaseQty)),
      )
    }
  }
  for (const m of materials) {
    if (!m.outsourcedWarehouseId) {
      throw new ApiError('conflict', '材料扣减行必须填写外协仓')
    }
    await validateOutsourcedWarehouse(
      trx,
      before.companyId,
      before.partyType,
      before.partyId,
      m.outsourcedWarehouseId,
    )
    stockLines.push({
      warehouseId: m.outsourcedWarehouseId,
      materialId: m.materialId,
      quantity: wq(m.baseQty),
      direction: 'out',
      remarks: m.remarks,
    })
  }
  for (const b of byproducts) {
    if (!b.warehouseId) {
      throw new ApiError('conflict', '副产物行必须填写入仓')
    }
    await validateEnabledLeafWarehouse(trx, before.companyId, b.warehouseId, '委外履约仓库不合法')
    stockLines.push({
      warehouseId: b.warehouseId,
      materialId: b.materialId,
      quantity: wq(b.baseQty),
      direction: 'in',
      remarks: b.remarks,
    })
  }

  await postFulfillment(trx, 'purchase', {
    companyId: before.companyId,
    partyType: before.partyType,
    partyId: before.partyId,
    requireOutsourced: true,
    lines: projectionLines,
  })

  if (stockLines.length > 0) {
    await engines.inventory.post(
      trx,
      {
        type: RECEIPT_PREFIX,
        id: before.id,
        no: before.receiptNo,
        companyId: before.companyId,
        postingDate: before.receiptDate,
      },
      stockLines,
    )
  }

  const glAmount = decimal(roundAmount(amount))
  let postingDate = before.postingDate ?? before.receiptDate
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
    credit.partyType = lowerPartyType(before.partyType)
    credit.partyId = before.partyId
    await engines.gl.post(
      trx,
      {
        type: RECEIPT_PREFIX,
        id: before.id,
        no: before.receiptNo,
        companyId: before.companyId,
        postingDate,
      },
      [debit, credit],
    )
  }
  return { posting_date: postingDate }
}

export async function effectVoidReceipt(
  trx: TrxHandle,
  engines: {
    inventory: Pick<InventoryEngine, 'post' | 'cancel'>
    gl: Pick<GlEngine, 'post' | 'cancel'>
  },
  before: ReceiptHead,
): Promise<void> {
  const { items } = await loadReceiptActionLines(trx, before.id)
  for (const item of items) {
    if (decimal(item.reconciledQty).gt(0)) {
      throw new ApiError('conflict', '存在已对账成品行,不可作废')
    }
  }
  const lines = items.map((i) => ({ orderItemId: i.orderItemId, baseQty: i.baseQty }))
  await reverseFulfillment(trx, 'purchase', {
    companyId: before.companyId,
    partyType: before.partyType,
    partyId: before.partyId,
    requireOutsourced: true,
    lines,
  })
  await engines.inventory.cancel(trx, { type: RECEIPT_PREFIX, id: before.id })
  await engines.gl.cancel(trx, { type: RECEIPT_PREFIX, id: before.id })
}
