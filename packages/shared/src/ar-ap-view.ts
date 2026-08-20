/**
 * 应收应付报表当前视图：tab 过滤、对手搜索/类型筛选、排序。
 * 列表页与打印装配共用，避免导出与屏幕各写一套。
 */

export const AR_AP_PARTY_TYPE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  SUPPLIER: '供应商',
  COMPANY: '内部公司',
  EMPLOYEE: '员工',
}

export type ArApLedgerSide = 'ar' | 'ap'

export const AR_AP_SIDE_LABEL: Record<ArApLedgerSide, string> = {
  ar: '应收',
  ap: '应付',
}

export const AR_AP_ROLE_KEYS = {
  ar: ['unbilledReceivable', 'receivable'] as const,
  ap: ['unbilledPayable', 'payable', 'otherPayable'] as const,
}

export interface ArApViewRow {
  partyType: string | null
  partyId: string | null
  partyLabel: string
  balances: Record<string, string>
  netReceivable: string
  netPayable: string
}

export interface ArApViewQuery {
  side: ArApLedgerSide
  search?: string
  partyTypes?: readonly string[]
  sortColumn?: string
  sortDirection?: 'ascending' | 'descending'
}

export function netOfRow(row: ArApViewRow, side: ArApLedgerSide): string {
  return side === 'ar' ? row.netReceivable : row.netPayable
}

export function nonZeroAmount(value: string | undefined): boolean {
  return value != null && Number(value) !== 0
}

export function tabArApRows(rows: readonly ArApViewRow[], side: ArApLedgerSide): ArApViewRow[] {
  const keys = AR_AP_ROLE_KEYS[side]
  return rows.filter(
    (row) => keys.some((key) => nonZeroAmount(row.balances[key])) || nonZeroAmount(netOfRow(row, side)),
  )
}

export function visibleArApRows(
  rows: readonly ArApViewRow[],
  query: ArApViewQuery,
): ArApViewRow[] {
  const needle = (query.search ?? '').trim().toLowerCase()
  const types = new Set((query.partyTypes ?? []).map((value) => value.toUpperCase()))
  const filtered = tabArApRows(rows, query.side).filter((row) => {
    if (needle && !row.partyLabel.toLowerCase().includes(needle)) return false
    if (types.size > 0) {
      if (row.partyType == null) return false
      if (!types.has(row.partyType.toUpperCase())) return false
    }
    return true
  })
  const column = query.sortColumn ?? 'net'
  const dir = query.sortDirection === 'ascending' ? 1 : -1
  const valueOf = (row: ArApViewRow): string | number => {
    if (column === 'party') return row.partyLabel
    if (column === 'partyType') {
      return row.partyType ? (AR_AP_PARTY_TYPE_LABEL[row.partyType] ?? row.partyType) : ''
    }
    if (column === 'net') return Number(netOfRow(row, query.side) || 0)
    return Number(row.balances[column] || 0)
  }
  return [...filtered].sort((a, b) => {
    const aNil = a.partyId == null
    const bNil = b.partyId == null
    if (aNil !== bNil) return aNil ? 1 : -1
    const av = valueOf(a)
    const bv = valueOf(b)
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv, 'zh') * dir
    }
    return (Number(av) - Number(bv)) * dir
  })
}
