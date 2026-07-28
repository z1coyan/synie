/**
 * 回归：履约条目列表的 calculated 父单字段 dbColumn 必须能被 filterbuild 用于 ORDER BY / WHERE。
 * listItems 子查询须以同名列暴露这些字段（不可再 alias 成 head_date 等）。
 */
import { describe, expect, test } from 'bun:test'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import type { ListQuery } from '@synie/shared'
import { buildListQuery } from '~/db/filterbuild.ts'
import { fulfillmentItemMeta } from './spec.ts'

const dummyDb = new Kysely<never>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

function compileOrder(resource: ReturnType<typeof fulfillmentItemMeta>, query: ListQuery) {
  const built = buildListQuery(resource, query)
  let q = dummyDb.selectFrom('x' as never).selectAll()
  if (built.orderBy) q = q.orderBy(built.orderBy as never)
  if (built.where) q = q.where(built.where as never)
  return q.compile()
}

describe('fulfillment item list source columns', () => {
  test('purchase: sort/filter receiptDate → receipt_date (not head_date)', () => {
    const meta = fulfillmentItemMeta('purchase')
    const date = meta.fields.find((f) => f.apiName === 'receiptDate')
    expect(date?.dbColumn).toBe('receipt_date')
    expect(date?.sortable).toBe(true)
    expect(date?.filterable).toBe(true)

    const { sql } = compileOrder(meta, {
      limit: 20,
      offset: 0,
      sort: { column: 'receiptDate', direction: 'descending' },
      filter: { receiptDate: { kind: 'date', op: 'after', value: '2026-01-01' } },
    })
    expect(sql).toContain('"receipt_date"')
    expect(sql).not.toContain('head_date')
  })

  test('sales: sort/filter deliveryDate → delivery_date (not head_date)', () => {
    const meta = fulfillmentItemMeta('sales')
    const date = meta.fields.find((f) => f.apiName === 'deliveryDate')
    expect(date?.dbColumn).toBe('delivery_date')

    const { sql } = compileOrder(meta, {
      limit: 20,
      offset: 0,
      sort: { column: 'deliveryDate', direction: 'descending' },
    })
    expect(sql).toContain('"delivery_date"')
    expect(sql).not.toContain('head_date')
  })

  test('parent no/status dbColumns match side-specific names used by listItems source', () => {
    const pur = fulfillmentItemMeta('purchase')
    const sal = fulfillmentItemMeta('sales')
    const col = (meta: typeof pur, api: string) => meta.fields.find((f) => f.apiName === api)?.dbColumn
    expect(col(pur, 'receiptNo')).toBe('receipt_no')
    expect(col(pur, 'receiptStatus')).toBe('receipt_status')
    expect(col(sal, 'deliveryNo')).toBe('delivery_no')
    expect(col(sal, 'deliveryStatus')).toBe('delivery_status')
  })
})
