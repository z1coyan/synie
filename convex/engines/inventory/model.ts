import type { Id } from '../../_generated/dataModel'
import { decimalToScaledInt64 } from '../../lib/decimal'
import { synieError, validationError } from '../../lib/errors'
import { assertDateOnly, checkedAdd } from '../shared'

export type StockVoucher = {
  type: string
  id: string
  no: string
  companyId: string
  postingDate: string
}

export type StockLine = {
  warehouseId: Id<'warehouses'>
  materialId: Id<'materials'>
  quantity: string
  direction: 'in' | 'out'
}

export type NormalizedStockLine = StockLine & { signedBaseQty: bigint }

export function validateVoucher(voucher: StockVoucher): void {
  const fields: Record<string, string[]> = {}
  if (!voucher.type.trim()) fields.voucherType = ['必填']
  if (!voucher.id.trim()) fields.voucherId = ['必填']
  if (!voucher.no.trim()) fields.voucherNo = ['必填']
  if (!voucher.companyId.trim()) fields.companyId = ['必填']
  if (!voucher.postingDate.trim()) fields.postingDate = ['必填']
  if (Object.keys(fields).length) throw validationError('库存过账参数不合法', fields)
  assertDateOnly(voucher.postingDate)
}

export function normalizeLines(lines: readonly StockLine[]): NormalizedStockLine[] {
  if (lines.length === 0) throw synieError('validation', '库存过账校验失败')
  return lines.map((line, index) => {
    let quantity: bigint
    try {
      quantity = decimalToScaledInt64(line.quantity, 6)
    } catch {
      throw validationError('库存过账校验失败', { [`lines.${index}.quantity`]: ['数量必须是十进制字符串'] })
    }
    if (quantity <= 0n) {
      throw validationError('库存过账校验失败', { [`lines.${index}.quantity`]: ['数量必须大于零'] })
    }
    return { ...line, signedBaseQty: line.direction === 'out' ? -quantity : quantity }
  })
}

export type StockDelta = {
  warehouseId: Id<'warehouses'>
  materialId: Id<'materials'>
  delta: bigint
}

export function groupDeltas(lines: readonly NormalizedStockLine[]): StockDelta[] {
  const result = new Map<string, StockDelta>()
  for (const line of lines) {
    const key = `${line.warehouseId}\u0000${line.materialId}`
    const previous = result.get(key)
    result.set(key, {
      warehouseId: line.warehouseId,
      materialId: line.materialId,
      delta: checkedAdd(previous?.delta ?? 0n, line.signedBaseQty),
    })
  }
  return [...result.values()].sort((a, b) =>
    `${a.warehouseId}/${a.materialId}`.localeCompare(`${b.warehouseId}/${b.materialId}`),
  )
}
