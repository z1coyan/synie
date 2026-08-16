/**
 * 总账分录 db→wire：对手类型必须走平台枚举约定（库内小写、wire 大写）。
 * 手写 mapEntry 漏掉 toUpperCase 时，前端枚举标签与多态对手都会对不上，
 * 页面就会裸出 "customer" / 截断 id。
 */
import { expect, test } from 'bun:test'
import { mapEntry } from './entry-service.ts'

const base = {
  id: '00000000-0000-0000-0000-000000000001',
  seq: 1,
  posting_date: '2026-07-26',
  debit: '125.50',
  credit: '0',
  party_id: '00000000-0000-0000-0000-000000000002',
  voucher_type: 'acc.gl_journal',
  voucher_id: '00000000-0000-0000-0000-000000000003',
  voucher_no: 'T(J)-0001',
  is_cancelled: false,
  is_reversed: false,
  is_reversal: false,
  remarks: null,
  inserted_at: new Date('2026-07-26T00:00:00Z'),
  company_id: '00000000-0000-0000-0000-000000000004',
  account_id: '00000000-0000-0000-0000-000000000005',
  currency_id: '00000000-0000-0000-0000-000000000006',
}

test('对手类型：库内小写 → wire 大写 token', () => {
  for (const [db, wire] of [
    ['customer', 'CUSTOMER'],
    ['supplier', 'SUPPLIER'],
    ['company', 'COMPANY'],
    ['employee', 'EMPLOYEE'],
  ] as const) {
    const item = mapEntry({ ...base, party_type: db })
    expect(item.partyType).toBe(wire)
  }
})

test('对手类型空值保持 null', () => {
  expect(mapEntry({ ...base, party_type: null, party_id: null }).partyType).toBeNull()
})
