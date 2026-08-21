// bun run check 覆盖：待发货预设写/清/选中（其它标签保留）
import type { FilterState } from '~/components/synie-data-grid/types'
import {
  applyPendingShip,
  clearPendingShip,
  isPendingShipFilters,
  PENDING_SHIP_FILTERS,
} from './-pending-ship-filters'

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

eq(isPendingShipFilters(PENDING_SHIP_FILTERS), true, '默认两键即待发货')
eq(isPendingShipFilters({}), false, '空筛选不是待发货')
eq(
  isPendingShipFilters({
    ...PENDING_SHIP_FILTERS,
    partyId: { kind: 'fk', values: ['c1'], labels: ['客户甲'] },
  }),
  true,
  '多一个用户标签仍选中待发货',
)
eq(
  isPendingShipFilters({
    orderStatus: { kind: 'enum', values: ['AUDITED', 'DRAFT'] },
    remainingBaseQty: { kind: 'number', op: 'gt', value: '0' },
  }),
  false,
  '状态多勾草稿不是待发货',
)
eq(
  isPendingShipFilters({
    orderStatus: { kind: 'enum', values: ['CLOSED'] },
    remainingBaseQty: { kind: 'number', op: 'gt', value: '0' },
  }),
  false,
  'CLOSED 不算 AUDITED',
)
eq(
  isPendingShipFilters({
    orderStatus: { kind: 'enum', values: ['AUDITED'] },
    remainingBaseQty: { kind: 'number', op: 'gte', value: '0' },
  }),
  false,
  '未发数量不是 gt 0 则不选中',
)

const withCustomer: FilterState = {
  partyId: { kind: 'fk', values: ['c1'], labels: ['客户甲'] },
}
eq(
  applyPendingShip(withCustomer),
  { ...withCustomer, ...PENDING_SHIP_FILTERS },
  '待发货只写两键、保留客户',
)
eq(clearPendingShip({ ...withCustomer, ...PENDING_SHIP_FILTERS }), withCustomer, '全部只去掉两键')
eq(clearPendingShip(PENDING_SHIP_FILTERS), {}, '全部去掉后为空')

console.log('pending-ship-filters-checks ok')
