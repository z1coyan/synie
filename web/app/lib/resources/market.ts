import {
  unboundCommandAdapter,
  unboundResourceClient,
  unavailableResourceOperation,
} from './unbound'

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
  items: Array<{ code?: string; message?: string | null; status?: string }>
}

export type MarketSeriesPriceKind = string

export interface MarketSemanticOperations {
  chartInstruments(): Promise<MarketChartInstrument[]>
  priceSeries(input: {
    instrumentIds: string[]
    priceKind: MarketSeriesPriceKind
    from: string
    to: string
  }): Promise<MarketPriceSeries>
  refresh(input: Record<string, unknown>): Promise<MarketRefreshResult>
}

let semanticOperations: MarketSemanticOperations | null = null

export function activateMarketSemanticOperations(
  operations: MarketSemanticOperations,
): void {
  semanticOperations = operations
}

function market(): MarketSemanticOperations {
  if (!semanticOperations) throw new Error('行情能力尚未由 Convex 应用壳装配')
  return semanticOperations
}

export const marketInstrumentClient = unboundResourceClient('basMarketInstruments')
export const marketPricePointClient = unboundResourceClient('basMarketPricePoints')
export const marketPricePointCommandAdapter = unboundCommandAdapter({ void: 'row' })
export const voidMarketPricePoint = unavailableResourceOperation

export const getMarketChartInstruments = () => market().chartInstruments()
export const getMarketPriceSeries = (input: {
  instrumentIds: string[]
  priceKind: MarketSeriesPriceKind
  from: string
  to: string
}) => market().priceSeries(input)
export const refreshMarketPricePoints = (
  input: Record<string, unknown> = {},
) => market().refresh(input)
