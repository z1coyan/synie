/**
 * 回归：履约条目列表的 calculated 父单字段 dbColumn 必须能被 filterbuild 用于 ORDER BY / WHERE。
 * listItems 子查询须以同名列暴露这些字段（不可再 alias 成 head_date 等）。
 * 另回归授权 via 链：判定谓词经 join 链落在发货单/入库单上，链上的 fk 列必须被投影暴露。
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
import { toReadSpec } from '~/platform/meta/read-spec.ts'
import { resolveAuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import {
  fulfillmentHeadMeta,
  fulfillmentItemMeta,
  packBoxMeta,
  packLineMeta,
  PACK_BOX_RESOURCE,
  PACK_LINE_RESOURCE,
} from './spec.ts'

const METAS: ResourceMeta[] = [
  fulfillmentHeadMeta('sales'),
  fulfillmentHeadMeta('purchase'),
  fulfillmentItemMeta('sales'),
  fulfillmentItemMeta('purchase'),
  packBoxMeta(),
  packLineMeta(),
]
const lookup = (name: string) => METAS.find((meta) => meta.name === name)

const dummyDb = new Kysely<never>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

function compileOrder(resource: ReturnType<typeof fulfillmentItemMeta>, query: ListQuery) {
  const built = buildListQuery(toReadSpec(resource), query)
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

  test('条目 via 链一级递归到母单，链上 fk 列由投影暴露（i.* / 裸表）', () => {
    for (const side of ['sales', 'purchase'] as const) {
      const item = fulfillmentItemMeta(side)
      const target = resolveAuthzTarget(item.name, lookup)
      expect(target.rootResource).toBe(fulfillmentHeadMeta(side).name)
      expect(target.chain).toHaveLength(1)
      expect(target.chain[0]).toEqual({
        childTable: item.table,
        fk: side === 'sales' ? 'delivery_id' : 'receipt_id',
        parentTable: fulfillmentHeadMeta(side).table,
      })
      expect(item.fields.some((f) => f.dbColumn === target.chain[0]!.fk)).toBe(true)
    }
  })

  test('装箱行 via 链两级：pack_line → pack_box → sal_delivery', () => {
    const target = resolveAuthzTarget(PACK_LINE_RESOURCE, lookup)
    expect(target.rootResource).toBe(fulfillmentHeadMeta('sales').name)
    expect(target.chain).toEqual([
      {
        childTable: packLineMeta().table,
        fk: 'pack_box_id',
        parentTable: packBoxMeta().table,
      },
      {
        childTable: packBoxMeta().table,
        fk: 'delivery_id',
        parentTable: fulfillmentHeadMeta('sales').table,
      },
    ])
    // 判定谓词落在发货单的公司列上（装箱箱/行自己的 company_id 不参与判定）
    expect(target.root.company?.column).toBe('company_id')
    expect(target.prefix).toBe('sales.delivery')
    expect(resolveAuthzTarget(PACK_BOX_RESOURCE, lookup).chain).toHaveLength(1)
  })
})
