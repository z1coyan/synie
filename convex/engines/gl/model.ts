import type { Id } from '../../_generated/dataModel'
import { decimalToScaledInt64 } from '../../lib/decimal'
import { synieError, validationError } from '../../lib/errors'
import { assertDateOnly, checkedAdd } from '../shared'

export const PARTY_REQUIRED_ROLES = new Set([
  'unbilled_receivable',
  'receivable',
  'advance_received',
  'unbilled_payable',
  'payable',
  'advance_paid',
  'other_payable',
])

export type GlVoucher = {
  type: string
  id: string
  no: string
  companyId: string
  postingDate: string
}

export type GlLine = {
  accountId: Id<'accounts'>
  currencyId?: Id<'currencies'> | null
  debit?: string
  credit?: string
  partyType?: string | null
  partyId?: string | null
}

export type NormalizedGlLine = GlLine & {
  currencyId: Id<'currencies'> | null
  debitScaled: bigint
  creditScaled: bigint
  partyType: string | null
  partyId: string | null
}

export function validateGlVoucher(voucher: GlVoucher): void {
  const fields: Record<string, string[]> = {}
  if (!voucher.type.trim()) fields.voucherType = ['必填']
  if (!voucher.id.trim()) fields.voucherId = ['必填']
  if (!voucher.no.trim()) fields.voucherNo = ['必填']
  if (!voucher.companyId.trim()) fields.companyId = ['必填']
  if (!voucher.postingDate.trim()) fields.postingDate = ['必填']
  if (Object.keys(fields).length) throw validationError('总账过账参数不合法', fields)
  assertDateOnly(voucher.postingDate)
}

function amount(value: string | undefined, index: number, side: 'debit' | 'credit'): bigint {
  try {
    return decimalToScaledInt64(value ?? '0', 2)
  } catch {
    throw validationError('总账过账校验失败', { [`lines.${index}.${side}`]: ['金额必须是十进制字符串'] })
  }
}

export function normalizeGlLines(lines: readonly GlLine[], allowNegative = false): NormalizedGlLine[] {
  if (lines.length < 2) throw validationError('总账过账校验失败', { entries: ['分录不少于两行'] })
  let debits = 0n
  let credits = 0n
  const normalized = lines.map((line, index) => {
    const debitScaled = amount(line.debit, index, 'debit')
    const creditScaled = amount(line.credit, index, 'credit')
    const validSide = allowNegative
      ? (debitScaled !== 0n) !== (creditScaled !== 0n)
      : (debitScaled > 0n) !== (creditScaled > 0n) && debitScaled >= 0n && creditScaled >= 0n
    if (!validSide) throw validationError('总账过账校验失败', { entries: ['每行借贷必须恰一边大于零'] })
    const partyType = line.partyType?.trim() || null
    const partyId = line.partyId?.trim() || null
    if (Boolean(partyType) !== Boolean(partyId)) {
      throw validationError('总账过账校验失败', { entries: ['对手类型与对手必须同时填写'] })
    }
    debits = checkedAdd(debits, debitScaled)
    credits = checkedAdd(credits, creditScaled)
    return {
      ...line,
      currencyId: line.currencyId ?? null,
      debitScaled,
      creditScaled,
      partyType,
      partyId,
    }
  })
  if (debits !== credits) throw validationError('总账过账校验失败', { entries: ['借贷不平'] })
  return normalized
}
