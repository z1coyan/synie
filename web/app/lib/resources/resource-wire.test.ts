import { describe, expect, test } from 'bun:test'
import {
  dateTimeWireInput,
  dateTimeWireValue,
  decimalWireInput,
  resourceListBody,
  strictResourceListBody,
} from './resource-wire'

describe('resource wire module', () => {
  test('列表 query 合并筛选且不把资源内字段泄漏进 wire body', () => {
    expect(
      resourceListBody({
        limit: 20,
        offset: 40,
        search: '',
        sort: null,
        filter: {
          status: { kind: 'enum', values: ['DRAFT'] },
        },
        fixedFilter: {
          companyId: {
            kind: 'fk',
            values: ['company-1'],
            labels: ['一公司'],
          },
        },
        extraFields: ['materialName'],
        joinFields: { material: ['code'] },
      }),
    ).toEqual({
      limit: 20,
      offset: 40,
      search: undefined,
      sort: undefined,
      filter: {
        status: { kind: 'enum', values: ['DRAFT'] },
        companyId: {
          kind: 'fk',
          values: ['company-1'],
          labels: ['一公司'],
        },
      },
    })
  })

  test('strict endpoint 对未支持 query 能力 fail-closed', () => {
    expect(() =>
      strictResourceListBody(
        {
          limit: 20,
          offset: 0,
          fixedFilter: { companyId: { eq: 'company-1' } },
          extraFields: ['companyName'],
        },
        'IAM',
      ),
    ).toThrow(/IAM.*fixedFilter.*extraFields/)
  })

  test('decimal codec 区分普通空值 null 与金额归零，并保留 PATCH absent', () => {
    expect(
      decimalWireInput(
        { qty: 2.5, price: '', untouched: true },
        ['qty', 'price', 'missing'],
      ),
    ).toEqual({ qty: '2.5', price: null, untouched: true })
    expect(
      decimalWireInput(
        { debit: '', credit: 3 },
        ['debit', 'credit'],
        { empty: '0' },
      ),
    ).toEqual({ debit: '0', credit: '3' })
  })

  test('date codec 只转换 YYYY-MM-DD，其他 wire 值保持不变', () => {
    expect(dateTimeWireValue('2026-07-31')).toBe('2026-07-31T00:00:00Z')
    expect(dateTimeWireValue('2026-07-31T12:30:00Z')).toBe(
      '2026-07-31T12:30:00Z',
    )
    expect(
      dateTimeWireInput(
        { docDate: '2026-07-31', postedAt: null, note: 'ok' },
        ['docDate', 'postedAt', 'missing'],
      ),
    ).toEqual({
      docDate: '2026-07-31T00:00:00Z',
      postedAt: null,
      note: 'ok',
    })
  })
})
