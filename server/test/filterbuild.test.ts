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
import { ApiError } from '~/platform/http/errors.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { quotationItemMeta } from '~/modules/trading/quotation/spec.ts'

/** 用 DummyDriver 编译查询：断言生成的 SQL 文本与参数（等价 server-go 的字符串断言） */
const dummyDb = new Kysely<never>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

const resource: ResourceMeta = {
  name: 'basUnits',
  permissionPrefix: 'base.unit',
  permissionLabel: '计量单位',
  table: 'bas_unit',
  fields: [
    { name: 'id', apiName: 'id', dbColumn: 'id', type: 'uuid', label: 'ID', sortable: true },
    { name: 'name', apiName: 'name', dbColumn: 'name', type: 'string', label: '名称', filterable: true, sortable: true },
    { name: 'symbol', apiName: 'symbol', dbColumn: 'symbol', type: 'string', label: '符号', filterable: true, sortable: true },
    { name: 'active', apiName: 'active', dbColumn: 'active', type: 'boolean', label: '启用', filterable: true },
    { name: 'ratio', apiName: 'ratio', dbColumn: 'ratio', type: 'decimal', label: '换算比例', filterable: true },
    {
      name: 'type', apiName: 'type', dbColumn: 'type', type: 'enum', label: '类型', filterable: true,
      enumOptions: [
        { value: 'LENGTH', label: '长度' },
        { value: 'WEIGHT', label: '重量' },
      ],
    },
    { name: 'created_at', apiName: 'createdAt', dbColumn: 'created_at', type: 'datetime', label: '创建时间', filterable: true },
    {
      name: 'company_id', apiName: 'companyId', dbColumn: 'company_id', type: 'fk', label: '公司', filterable: true,
      ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
    },
  ],
  actions: [],
}

function compile(query: ListQuery) {
  const built = buildListQuery(toReadSpec(resource), query)
  let q = dummyDb.selectFrom('bas_unit' as never).selectAll()
  if (built.where) q = q.where(built.where as never)
  if (built.orderBy) q = q.orderBy(built.orderBy as never)
  return q.compile()
}

const base: ListQuery = { limit: 50, offset: 0 }

describe('filterbuild', () => {
  test('文本 contains 转义通配符并参数化', () => {
    const { sql, parameters } = compile({ ...base, filter: { name: { kind: 'text', op: 'contains', value: '50%_\\' } } })
    expect(sql).toContain('"name" ILIKE')
    expect(sql).toContain("ESCAPE '\\'")
    expect(parameters).toEqual(['50\\%\\_\\\\'])
  })

  test('布尔与枚举（枚举 wire 大写转存储小写）', () => {
    const { sql, parameters } = compile({
      ...base,
      filter: {
        active: { kind: 'bool', eq: true },
        type: { kind: 'enum', values: ['LENGTH', 'WEIGHT'] },
      },
    })
    expect(sql).toContain('"active" = $1')
    expect(sql).toContain('"type" = ANY($2::text[])')
    expect(parameters).toEqual([true, ['length', 'weight']])
  })

  test('未知枚举值拒绝', () => {
    expect(() => compile({ ...base, filter: { type: { kind: 'enum', values: ['AREA'] } } })).toThrow(ApiError)
  })

  test('数值 between 与单值 op', () => {
    const between = compile({ ...base, filter: { ratio: { kind: 'number', op: 'between', gte: '0.1', lte: '2' } } })
    expect(between.sql).toContain('"ratio" >= $1::numeric')
    expect(between.sql).toContain('"ratio" <= $2::numeric')
    expect(between.parameters).toEqual(['0.1', '2'])

    const gt = compile({ ...base, filter: { ratio: { kind: 'number', op: 'gt', value: '1.5' } } })
    expect(gt.sql).toContain('"ratio" > $1::numeric')
  })

  test('datetime eq 展开为日界区间', () => {
    const { sql, parameters } = compile({ ...base, filter: { createdAt: { kind: 'date', op: 'eq', value: '2026-07-28' } } })
    expect(sql).toContain('"created_at" >= $1::date')
    expect(sql).toContain('"created_at" < ($2::date + INTERVAL \'1 day\')')
    expect(parameters).toEqual(['2026-07-28', '2026-07-28'])
  })

  test('fk in 校验 UUID，isNil 生成 IS NULL', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const { sql, parameters } = compile({ ...base, filter: { companyId: { kind: 'fk', op: 'in', values: [id], labels: [] } } })
    expect(sql).toContain('"company_id"::text = ANY($1::text[])')
    expect(parameters).toEqual([[id]])

    const nil = compile({ ...base, filter: { companyId: { kind: 'fk', op: 'isNil', values: [], labels: [] } } })
    expect(nil.sql).toContain('"company_id" IS NULL')

    expect(() => compile({ ...base, filter: { companyId: { kind: 'fk', values: ['not-uuid'], labels: [] } } })).toThrow(ApiError)
  })

  test('fk/enum 缺 values 返回 validation 而非 TypeError', () => {
    // 路由层 filter 为 z.record(unknown)，畸形 body 必须在 filterbuild 以 400 收口
    try {
      compile({
        ...base,
        filter: { companyId: { kind: 'fk', op: 'eq', value: '11111111-1111-4111-8111-111111111111' } as never },
      })
      throw new Error('应抛出 ApiError')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('validation')
    }
    try {
      compile({ ...base, filter: { type: { kind: 'enum' } as never } })
      throw new Error('应抛出 ApiError')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('validation')
    }
  })

  test('search 跨可筛选字符串列 OR', () => {
    const { sql, parameters } = compile({ ...base, search: '千克' })
    expect(sql).toContain('OR')
    expect((sql.match(/ILIKE/g) ?? []).length).toBe(2)
    expect(parameters).toEqual(['千克', '千克'])
  })

  test('sort 白名单与方向', () => {
    const { sql } = compile({ ...base, sort: { column: 'symbol', direction: 'descending' } })
    expect(sql).toContain('order by "symbol" DESC')
    expect(() => compile({ ...base, sort: { column: 'ratio', direction: 'ascending' } })).toThrow(ApiError)
  })

  test('未知字段与 kind 不匹配拒绝', () => {
    expect(() => compile({ ...base, filter: { hacker: { kind: 'text', op: 'eq', value: 'x' } } })).toThrow(ApiError)
    expect(() => compile({ ...base, filter: { name: { kind: 'bool', eq: true } } })).toThrow(ApiError)
  })

  test('销售/采购报价条目允许按币种 ID 筛选订单候选', () => {
    const currencyId = '11111111-1111-4111-8111-111111111111'
    for (const side of ['sales', 'purchase'] as const) {
      const built = buildListQuery(toReadSpec(quotationItemMeta(side)), {
        ...base,
        filter: {
          currencyId: { kind: 'fk', op: 'in', values: [currencyId], labels: [] },
        },
      })
      let query = dummyDb.selectFrom('quotation_items' as never).selectAll()
      if (built.where) query = query.where(built.where as never)
      const { sql, parameters } = query.compile()
      expect(sql).toContain('"currency_id"::text = ANY($1::text[])')
      expect(parameters).toEqual([[currencyId]])
    }
  })

  test('无筛选无排序时 where/orderBy 均为 null', () => {
    const built = buildListQuery(toReadSpec(resource), base)
    expect(built.where).toBeNull()
    expect(built.orderBy).toBeNull()
  })
})
