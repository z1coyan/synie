import { decimalToScaledInt64 } from '../lib/decimal'
import { validationError } from '../lib/errors'

export const UNIT_TYPES = ['LENGTH', 'AREA', 'WEIGHT', 'QUANTITY'] as const
export type UnitType = (typeof UNIT_TYPES)[number]
export const PARTY_TYPES = ['SUPPLIER', 'COMPANY'] as const
export type PartyType = (typeof PARTY_TYPES)[number]

function length(value: string): number {
  return [...value].length
}

export function normalizedKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

export function normalizeCurrency(input: {
  name: string
  isoCode: string
  symbol?: string | null
}): { name: string; nameKey: string; isoCode: string; isoCodeKey: string; symbol: string | null; searchText: string } {
  const name = input.name.trim()
  const isoCode = input.isoCode.trim()
  const symbol = input.symbol == null ? null : input.symbol.trim()
  const fields: Record<string, string[]> = {}
  if (!name) fields.name = ['不能为空']
  else if (length(name) > 64) fields.name = ['最多 64 个字符']
  if (!/^[A-Z]{3}$/.test(isoCode)) fields.isoCode = ['必须是 ISO 4217 三位大写字母编码']
  if (symbol !== null && length(symbol) > 8) fields.symbol = ['最多 8 个字符']
  if (Object.keys(fields).length > 0) throw validationError('币种参数不合法', fields)
  return {
    name,
    nameKey: normalizedKey(name),
    isoCode,
    isoCodeKey: normalizedKey(isoCode),
    symbol,
    searchText: `${name} ${isoCode}`,
  }
}

export function normalizeUnit(input: {
  unitType: string
  isBase: boolean
  name: string
  symbol: string
  ratio: string
}): {
  unitType: UnitType
  isBase: boolean
  name: string
  nameKey: string
  symbol: string
  symbolKey: string
  ratioScaled: bigint
  searchText: string
} {
  const unitType = input.unitType.trim().toUpperCase()
  const name = input.name.trim()
  const symbol = input.symbol.trim()
  const fields: Record<string, string[]> = {}
  if (!UNIT_TYPES.includes(unitType as UnitType)) fields.unitType = ['仅支持 LENGTH/AREA/WEIGHT/QUANTITY']
  if (!name || length(name) > 32) fields.name = ['不能为空且最多 32 个字符']
  if (!symbol || length(symbol) > 16) fields.symbol = ['不能为空且最多 16 个字符']
  let ratioScaled = 0n
  try {
    ratioScaled = decimalToScaledInt64(input.ratio.trim(), 6, { maxAbsScaled: 9_000_000_000_000_000n })
    if (ratioScaled <= 0n) fields.ratio = ['换算比例必须大于 0']
    else if (input.isBase && ratioScaled !== 1_000_000n) fields.ratio = ['基准单位换算比例必须为 1']
  } catch {
    fields.ratio = ['换算比例必须是范围内的十进制字符串']
  }
  if (Object.keys(fields).length > 0) throw validationError('计量单位参数不合法', fields)
  return {
    unitType: unitType as UnitType,
    isBase: input.isBase,
    name,
    nameKey: normalizedKey(name),
    symbol,
    symbolKey: normalizedKey(symbol),
    ratioScaled,
    searchText: `${name} ${symbol}`,
  }
}

export function normalizeWarehouse(input: {
  name: string
  isLeaf?: boolean
  active?: boolean
  isOutsourced?: boolean
  partyType?: string | null
  partyId?: string | null
  allowNegative?: boolean
  companyId: string
  parentId?: string | null
  accountId?: string | null
}) {
  const name = input.name.trim()
  const companyId = input.companyId.trim()
  const isOutsourced = input.isOutsourced ?? false
  const rawPartyType = input.partyType?.trim().toUpperCase() || null
  const partyId = input.partyId?.trim() || null
  const fields: Record<string, string[]> = {}
  if (!name || length(name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (!companyId) fields.companyId = ['不能为空']
  if (rawPartyType && !PARTY_TYPES.includes(rawPartyType as PartyType)) {
    fields.partyType = ['协作方类型只能为供应商或内部公司']
  }
  if (isOutsourced && (!rawPartyType || !partyId)) fields.partyId = ['外协仓必须绑定协作方']
  if (!isOutsourced && (rawPartyType || partyId)) fields.partyId = ['非外协仓不能绑定协作方']
  if (Object.keys(fields).length > 0) throw validationError('仓库参数不合法', fields)
  return {
    name,
    nameKey: normalizedKey(name),
    isLeaf: input.isLeaf ?? true,
    active: input.active ?? true,
    isOutsourced,
    partyType: rawPartyType as PartyType | null,
    partyId,
    allowNegative: input.allowNegative ?? false,
    companyId,
    parentId: input.parentId ?? null,
    accountId: input.accountId?.trim() || null,
    searchText: name,
  }
}
