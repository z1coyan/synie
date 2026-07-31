import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import { strictResourceListBody } from './resource-wire'
import type { ResourceClient, ResourceTransport } from './types'

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
  items: Array<{
    code?: string
    message?: string | null
    status?: string
  }>
}
export type MarketSeriesPriceKind = string

type MarketInstrumentCreate = Record<string, unknown>
type MarketInstrumentUpdate = Record<string, unknown>
type MarketPricePointCreate = Record<string, unknown>
type MarketPriceKind = string

function wirePriceKind(value: MarketSeriesPriceKind): MarketPriceKind {
  return value.toUpperCase() as never
}

export const marketInstrumentClient: ResourceClient = {
  id: 'rest:basMarketInstruments',


  async query(input) {
    const result = await apiData(
      api.base['market-instruments'].query.$post({
        json: strictResourceListBody(input, '行情品种'),
      }),
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
    await apiData(
      api.base['market-instruments'][':id'].$delete({ param: { id } }),
    )
  },
}

export async function voidMarketPricePoint(id: string) {
  return apiData(
    api.base['market-price-points'][':id'].void.$post({
      param: { id },
    }),
  )
}

export const marketPricePointCommandAdapter = createRowCommandAdapter({
  void: voidMarketPricePoint,
})

export const marketPricePointClient: ResourceTransport = {
  id: 'rest:basMarketPricePoints',


  async query(input) {
    const result = await apiData(
      api.base['market-price-points'].query.$post({
        json: strictResourceListBody(input, '行情价点'),
      }),
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

}

export function getMarketChartInstruments(): Promise<MarketChartInstrument[]> {
  return apiData(
    api.base['market-price-points']['chart-instruments'].$get(),
  )
}

export function getMarketPriceSeries(input: {
  instrumentIds: string[]
  priceKind: MarketSeriesPriceKind
  from: string
  to: string
}): Promise<MarketPriceSeries> {
  return apiData(
    api.base['market-price-points']['price-series'].$post({
      json: { ...input, priceKind: wirePriceKind(input.priceKind) } as never,
    }),
  )
}

export function refreshMarketPricePoints(
  input: Record<string, unknown> = {},
): Promise<MarketRefreshResult> {
  return apiData(
    api.base['market-price-points'].refresh.$post({ json: input as never }),
  )
}
