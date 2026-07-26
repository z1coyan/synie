import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

export type MarketChartInstrument = components['schemas']['MarketChartInstrument']
export type MarketPriceSeries = components['schemas']['MarketPriceSeries']
export type MarketPriceSeriesItem = components['schemas']['MarketPriceSeriesItem']
export type MarketRefreshResult = components['schemas']['MarketRefreshResult']
export type MarketSeriesPriceKind = components['schemas']['MarketSeriesPriceKind']

type MarketInstrumentCreate = components['schemas']['MarketInstrumentCreate']
type MarketInstrumentUpdate = components['schemas']['MarketInstrumentUpdate']
type MarketPricePointCreate = components['schemas']['MarketPricePointCreate']
type MarketPriceKind = components['schemas']['MarketPriceKind']

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
    filter: input.filter as components['schemas']['FilterState'],
  }
}

function wirePriceKind(value: MarketSeriesPriceKind): MarketPriceKind {
  return value.toUpperCase() as MarketPriceKind
}

export const marketInstrumentClient: ResourceClient = {
  id: 'rest:basMarketInstruments',

  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'basMarketInstruments' } },
        }),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery('行情品种', input)
    const result = await apiData(
      apiClient.POST('/base/market-instruments/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/base/market-instruments/{id}', { params: { path: { id } } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/base/market-instruments', { body: input as MarketInstrumentCreate }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/base/market-instruments/{id}', {
        params: { path: { id } },
        body: input as MarketInstrumentUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/base/market-instruments/{id}', { params: { path: { id } } }),
    )
  },
}

export const marketPricePointClient: ResourceClient = {
  id: 'rest:basMarketPricePoints',

  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'basMarketPricePoints' } },
        }),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery('行情价点', input)
    const result = await apiData(
      apiClient.POST('/base/market-price-points/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/base/market-price-points/{id}', { params: { path: { id } } }),
    )) as Row
  },

  async create(input) {
    const { instrumentId, observedAt, price, priceKind, note } = input
    const body = { instrumentId, observedAt, price, priceKind, note } as MarketPricePointCreate
    return (await apiData(
      apiClient.POST('/base/market-price-points', { body }),
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
          apiClient.POST('/base/market-price-points/{id}/void', {
            params: { path: { id } },
          }),
        ),
      ),
    )
  },
}

export function getMarketChartInstruments(): Promise<MarketChartInstrument[]> {
  return apiData(apiClient.GET('/base/market-price-points/chart-instruments'))
}

export function getMarketPriceSeries(input: {
  instrumentIds: string[]
  priceKind: MarketSeriesPriceKind
  from: string
  to: string
}): Promise<MarketPriceSeries> {
  return apiData(
    apiClient.POST('/base/market-price-points/price-series', {
      body: { ...input, priceKind: wirePriceKind(input.priceKind) },
    }),
  )
}

export function refreshMarketPricePoints(
  input: components['schemas']['MarketRefreshRequest'] = {},
): Promise<MarketRefreshResult> {
  return apiData(apiClient.POST('/base/market-price-points/refresh', { body: input }))
}
