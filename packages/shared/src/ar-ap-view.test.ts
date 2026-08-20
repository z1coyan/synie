import { describe, expect, test } from 'bun:test'
import { tabArApRows, visibleArApRows, type ArApViewRow } from './ar-ap-view.ts'

function row(
  label: string,
  partyId: string | null,
  extra: Partial<ArApViewRow> = {},
): ArApViewRow {
  return {
    partyType: partyId ? 'CUSTOMER' : null,
    partyId,
    partyLabel: label,
    balances: { unbilledReceivable: '0', receivable: '0' },
    netReceivable: '0',
    netPayable: '0',
    ...extra,
  }
}

describe('应收应付当前视图', () => {
  test('tab 只留本侧有余额或净额的行', () => {
    const rows = [
      row('甲', 'a', { balances: { receivable: '10' }, netReceivable: '10' }),
      row('乙', 'b', { balances: { payable: '8' }, netPayable: '8' }),
    ]
    expect(tabArApRows(rows, 'ar').map((r) => r.partyLabel)).toEqual(['甲'])
    expect(tabArApRows(rows, 'ap').map((r) => r.partyLabel)).toEqual(['乙'])
  })

  test('搜索与对手类型筛选后未指定对手沉底，默认净额倒序', () => {
    const rows = [
      row('未指定对手', null, { balances: { receivable: '1' }, netReceivable: '1' }),
      row('甲客户', 'a', {
        partyType: 'CUSTOMER',
        balances: { receivable: '3' },
        netReceivable: '3',
      }),
      row('乙供应商', 'b', {
        partyType: 'SUPPLIER',
        balances: { receivable: '9' },
        netReceivable: '9',
      }),
    ]
    const visible = visibleArApRows(rows, {
      side: 'ar',
      search: '客',
      partyTypes: ['CUSTOMER'],
      sortColumn: 'net',
      sortDirection: 'descending',
    })
    expect(visible.map((r) => r.partyLabel)).toEqual(['甲客户'])
  })
})
