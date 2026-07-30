import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'

export interface MarketChartInstrument {
  id: string
  instrumentId: string
  code: string
  name: string
  currencyId: string
  unitId: string
  currencyCode?: string | null
  unitName?: string | null
  defaultPriceKind: string
}
export interface MarketPriceSeriesItem {
  id: string
  instrumentId: string
  code: string
  name: string
  currencyId?: string
  unitId?: string
  points: Array<{ observedAt: string; price: string }>
}
export interface MarketPriceSeries {
  series: MarketPriceSeriesItem[]
  priceKind: string
  from?: string
  to?: string
}
export interface MarketRefreshResult {
  count: number
  items: Array<{ code?: string; message?: string; status?: string }>
}
export type MarketSeriesPriceKind = string

type MarketInstrumentCreate = Record<string, unknown>
type MarketInstrumentUpdate = Record<string, unknown>
type MarketPricePointCreate = Record<string, unknown>
type MarketPriceKind = string

function ensureSupportedQuery(resource: string, input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error(`${resource} REST 资源不支持额外字段、joinFields 或受信 fixedFilter`)
  }
}

function listBody(input: ResourceQuery) {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: input.filter as FilterState,
  }
}

function wirePriceKind(value: MarketSeriesPriceKind): MarketPriceKind {
  return value.toUpperCase() as never
}

export const marketInstrumentClient: ResourceClient = {
  id: 'rest:basMarketInstruments',


  async query(input) {
    ensureSupportedQuery('行情品种', input)
    const result = await apiData<{ count: number; results: Row[] }>(
      api.base['market-instruments'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.base['market-instruments'][':id'].$get({ param: { id } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.base['market-instruments'].$post({ json: input as never }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.base['market-instruments'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.base['market-instruments'][':id'].$delete({ param: { id } }),
    )
  },
}

export const marketPricePointClient: ResourceClient = {
  id: 'rest:basMarketPricePoints',


  async query(input) {
    ensureSupportedQuery('行情价点', input)
    const result = await apiData<{ count: number; results: Row[] }>(
      api.base['market-price-points'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.base['market-price-points'][':id'].$get({ param: { id } }),
    )) as Row
  },

  async create(input) {
    const { instrumentId, observedAt, price, priceKind, note } = input
    const body = { instrumentId, observedAt, price, priceKind, note } as never
    return (await apiData(
      api.base['market-price-points'].$post({ json: body }),
    )) as Row
  },

  async update() {
    throw new Error('行情价点不可编辑；请作废后重新录入')
  },

  async delete() {
    throw new Error('行情价点不可删除；请使用作废操作')
  },

  async action(key, ids) {
    if (key !== 'void') throw new Error(`行情价点不支持操作 ${key}`)
    await Promise.all(
      ids.map((id) =>
        apiData(
          api.base['market-price-points'][':id'].void.$post({
            param: { id }}),
        ),
      ),
    )
  },
}

export function getMarketChartInstruments(): Promise<MarketChartInstrument[]> {
  return apiData<MarketChartInstrument[]>(
    api.base['market-price-points']['chart-instruments'].$get(),
  )
}

export function getMarketPriceSeries(input: {
  instrumentIds: string[]
  priceKind: MarketSeriesPriceKind
  from: string
  to: string
}): Promise<MarketPriceSeries> {
  return apiData<MarketPriceSeries>(
    api.base['market-price-points']['price-series'].$post({
      json: { ...input, priceKind: wirePriceKind(input.priceKind) } as never,
    }),
  )
}

export function refreshMarketPricePoints(
  input: Record<string, unknown> = {},
): Promise<MarketRefreshResult> {
  return apiData<MarketRefreshResult>(
    api.base['market-price-points'].refresh.$post({ json: input as never }),
  )
}
