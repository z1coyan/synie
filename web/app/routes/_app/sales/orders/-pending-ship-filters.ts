import type { ColumnFilter, FilterState } from '~/components/synie-data-grid/types'

/** 订单条目「待发货」预设：已审核且未发数量 > 0（CLOSED/VOIDED 不是 AUDITED） */
export const PENDING_SHIP_FILTERS: FilterState = {
  orderStatus: { kind: 'enum', values: ['AUDITED'] },
  remainingBaseQty: { kind: 'number', op: 'gt', value: '0' },
}

const PENDING_SHIP_KEYS = ['orderStatus', 'remainingBaseQty'] as const

function sameEnumValues(filter: ColumnFilter | undefined, values: string[]): boolean {
  if (filter?.kind !== 'enum') return false
  if (filter.values.length !== values.length) return false
  return values.every((v) => filter.values.includes(v))
}

function isPendingShipQty(filter: ColumnFilter | undefined): boolean {
  return filter?.kind === 'number' && filter.op === 'gt' && filter.value === '0'
}

/** 这两键与待发货预设一致即选中（其它用户标签可并存） */
export function isPendingShipFilters(filters: FilterState): boolean {
  return (
    sameEnumValues(filters.orderStatus, ['AUDITED']) && isPendingShipQty(filters.remainingBaseQty)
  )
}

/** 只写待发货两键，保留其它标签 */
export function applyPendingShip(filters: FilterState): FilterState {
  return { ...filters, ...PENDING_SHIP_FILTERS }
}

/** 只去掉待发货两键，保留其它标签 */
export function clearPendingShip(filters: FilterState): FilterState {
  const next = { ...filters }
  for (const key of PENDING_SHIP_KEYS) delete next[key]
  return next
}
