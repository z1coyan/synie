import { describe, expect, test } from 'bun:test'
import {
  BUSINESS_DATE_FIELDS,
  defaultCompanyId,
  isBusinessDateField,
  todayLocal,
} from './form-defaults'
import type { FilterState, Row } from '~/components/synie-data-grid/types'

const co = (id: string, code = id): Row => ({ id, code }) as Row

describe('todayLocal', () => {
  test('返回 YYYY-MM-DD', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('defaultCompanyId', () => {
  test('列筛恰好 1 家时优先筛选项', () => {
    const filters: FilterState = {
      companyId: { kind: 'fk', op: 'in', values: ['c-filter'], labels: [] },
    }
    expect(defaultCompanyId(filters, [co('c1'), co('c2')])).toBe('c-filter')
  })

  test('无列筛时取授权列表第一家', () => {
    expect(defaultCompanyId({}, [co('a'), co('b')])).toBe('a')
    expect(defaultCompanyId(undefined, [co('only')])).toBe('only')
  })

  test('无公司时返回 null', () => {
    expect(defaultCompanyId({}, [])).toBeNull()
  })

  test('列筛多家时回落第一家授权公司', () => {
    const filters: FilterState = {
      companyId: { kind: 'fk', op: 'in', values: ['x', 'y'], labels: [] },
    }
    expect(defaultCompanyId(filters, [co('a'), co('b')])).toBe('a')
  })
})

describe('isBusinessDateField', () => {
  test('覆盖订单/入库/发货等业务日', () => {
    for (const name of [
      'orderDate',
      'receiptDate',
      'deliveryDate',
      'outputDate',
      'docDate',
      'invoiceDate',
      'date',
    ]) {
      expect(isBusinessDateField(name)).toBe(true)
      expect(BUSINESS_DATE_FIELDS.has(name)).toBe(true)
    }
  })

  test('过账日/到期日/交期不默认', () => {
    expect(isBusinessDateField('postingDate')).toBe(false)
    expect(isBusinessDateField('validUntil')).toBe(false)
    expect(isBusinessDateField('dueDate')).toBe(false)
    expect(isBusinessDateField('needDate')).toBe(false)
  })
})
