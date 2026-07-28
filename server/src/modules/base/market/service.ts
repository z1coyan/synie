import type { ListQuery } from '@synie/shared'
import type { Expression, Kysely, SqlBool } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { instrumentResourceMeta } from './meta.ts'

export interface MarketInstrument {
  id: string
  code: string
  name: string
  sourceType: string
  defaultPriceKind: string
  active: boolean
  fetchEnabled: boolean
  currencyId: string
  unitId: string
  insertedAt: Date
  updatedAt: Date
}

function mapRow(row: {
  id: string
  code: string
  name: string
  source_type: string
  default_price_kind: string
  active: boolean
  fetch_enabled: boolean
  currency_id: string
  unit_id: string
  inserted_at: Date
  updated_at: Date
}): MarketInstrument {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sourceType: row.source_type.toUpperCase(),
    defaultPriceKind: row.default_price_kind.toUpperCase(),
    active: row.active,
    fetchEnabled: row.fetch_enabled,
    currencyId: row.currency_id,
    unitId: row.unit_id,
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(row.inserted_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }
}

/** 行情品种：本分片先落地 list/get，写路径随工单 14 完整化 */
export function createMarketInstrumentService(db: Kysely<Database>) {
  async function list(
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: MarketInstrument[] }> {
    const limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
    const offset = query.offset ?? 0
    if (limit < 1 || limit > 200 || offset < 0) {
      const fields: Record<string, string[]> = {}
      if (limit < 1 || limit > 200) fields.limit = ['必须在 1 到 200 之间']
      if (offset < 0) fields.offset = ['不能小于 0']
      throw ApiError.validation('分页参数不合法', fields)
    }
    const built = buildListQuery(instrumentResourceMeta(), {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    })
    let countQ = db.selectFrom('bas_market_instrument').select(db.fn.countAll<string>().as('count'))
    if (built.where) countQ = countQ.where(built.where as Expression<SqlBool>)
    const count = Number((await countQ.executeTakeFirstOrThrow()).count)

    let rowsQ = db.selectFrom('bas_market_instrument').selectAll()
    if (built.where) rowsQ = rowsQ.where(built.where as Expression<SqlBool>)
    if (built.orderBy) rowsQ = rowsQ.orderBy(built.orderBy as never).orderBy('id')
    else rowsQ = rowsQ.orderBy('code', 'asc').orderBy('id', 'asc')
    const rows = await rowsQ.limit(limit).offset(offset).execute()
    return { count, results: rows.map(mapRow) }
  }

  async function get(id: string): Promise<MarketInstrument> {
    const row = await db
      .selectFrom('bas_market_instrument')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '行情品种不存在')
    return mapRow(row)
  }

  return { list, get }
}

export type MarketInstrumentService = ReturnType<typeof createMarketInstrumentService>
