import { decimal, toDecimalString, type Decimal } from './decimal.ts'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface MarketScheduleConfig {
  scheduleEnabled: boolean
  lastIntervalMinutes: number
  settlementEnabled: boolean
}

export interface MarketSlotKey {
  date: string
  slot: number
}

export interface MarketScheduleState {
  lasts: MarketSlotKey | null
  settlement: MarketSlotKey | null
}

export interface MarketScheduleDecision {
  runLasts: boolean
  runSettlements: boolean
  next: MarketScheduleState
}

export function emptyMarketScheduleState(): MarketScheduleState {
  return { lasts: null, settlement: null }
}

export function decideMarketSchedule(
  config: MarketScheduleConfig,
  now: Date,
  previous: MarketScheduleState,
): MarketScheduleDecision {
  const decision: MarketScheduleDecision = {
    runLasts: false,
    runSettlements: false,
    next: { lasts: previous.lasts, settlement: previous.settlement },
  }
  if (!config.scheduleEnabled) return decision

  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()
  const date = formatShanghaiDate(shanghai)
  const interval = normalizeMarketInterval(config.lastIntervalMinutes)
  const lastSlot = Math.floor(minutes / interval) * interval
  if (minutes - lastSlot <= 1 && inMarketLastSession(minutes)) {
    const key = { date, slot: lastSlot }
    if (!marketSlotEqual(previous.lasts, key)) {
      decision.runLasts = true
      decision.next.lasts = key
    }
  }

  if (config.settlementEnabled && isShanghaiWeekday(shanghai)) {
    const slot = marketSettlementSlot(minutes)
    if (slot !== null) {
      const key = { date, slot }
      if (!marketSlotEqual(previous.settlement, key)) {
        decision.runSettlements = true
        decision.next.settlement = key
      }
    }
  }
  return decision
}

export function normalizeMarketInterval(value: number): number {
  return value === 30 || value === 60 || value === 120 ? value : 60
}

export function inMarketLastSession(minutes: number): boolean {
  return (minutes >= 9 * 60 && minutes < 15 * 60 + 5) ||
    minutes >= 21 * 60 || minutes < 2 * 60 + 35
}

export function marketSettlementSlot(minutes: number): number | null {
  for (const slot of [15 * 60 + 30, 16 * 60, 16 * 60 + 30, 17 * 60]) {
    if (minutes >= slot && minutes <= slot + 1) return slot
  }
  return null
}

function isShanghaiWeekday(value: Date): boolean {
  const day = value.getUTCDay()
  return day !== 0 && day !== 6
}

function formatShanghaiDate(value: Date): string {
  const year = value.getUTCFullYear()
  const month = String(value.getUTCMonth() + 1).padStart(2, '0')
  const day = String(value.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function marketSlotEqual(left: MarketSlotKey | null, right: MarketSlotKey): boolean {
  return left !== null && left.date === right.date && left.slot === right.slot
}

export interface LastMarketQuote {
  price: Decimal
  asOfDate: string | null
}

export interface SettlementMarketQuote {
  price: Decimal
  deliveryMonth: string
  openInterest: number
}

export const MARKET_NOT_AVAILABLE = new Error('not available')

export function pastMarketSettlementWindow(now: Date): boolean {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  return shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes() >= 15 * 60 + 30
}

export function normalizeMarketLastSymbol(code: string): string {
  const trimmed = code.trim()
  return trimmed.startsWith('nf_') ? trimmed : `nf_${trimmed}`
}

export function parseSinaMarketLastBody(body: string, symbol: string): LastMarketQuote {
  const pattern = new RegExp(`hq_str_${escapeRegExp(symbol)}="([^"]*)"`)
  const match = pattern.exec(body)
  if (!match?.[1]) throw new Error(`新浪行情无数据(${symbol})`)
  const parts = match[1].split(',')
  if (parts.length <= 8) throw new Error('新浪行情缺少最新价')
  let price: Decimal
  try {
    price = decimal((parts[8] ?? '').trim())
  } catch {
    throw new Error('新浪最新价无效')
  }
  if (!price.greaterThan(0)) throw new Error('新浪最新价无效')
  const asOfDate = parts.length > 17 && (parts[17] ?? '').trim()
    ? (parts[17] ?? '').trim()
    : null
  return { price, asOfDate }
}

export function parseShfeMarketSettlement(
  payload: Record<string, unknown>,
  group: string,
): SettlementMarketQuote {
  const rows = Array.isArray(payload.o_curinstrument) ? payload.o_curinstrument : []
  const target = group.trim().toLowerCase()
  let best: SettlementMarketQuote | null = null
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const product = (marketStringField(row, 'PRODUCTGROUPID') || marketStringField(row, 'PRODUCTID')).toLowerCase()
    const deliveryMonth = marketStringField(row, 'DELIVERYMONTH')
    let price: Decimal
    try {
      price = decimal(marketStringField(row, 'SETTLEMENTPRICE'))
    } catch {
      continue
    }
    if (product !== target || !deliveryMonth || !price.greaterThan(0)) continue
    const openInterest = marketIntField(row, 'OPENINTEREST')
    if (!best || openInterest > best.openInterest) best = { price, deliveryMonth, openInterest }
  }
  if (!best) throw new Error(`上期所日数据无品种组 ${group} 的合约`)
  return best
}

export function compactMarketError(error: unknown): string {
  const value = String(error instanceof Error ? error.message : error)
    .split(/\s+/).filter(Boolean).join(' ')
  return [...value].slice(0, 200).join('')
}

export function marketQuotePrice(price: Decimal): string {
  return toDecimalString(price)
}

function marketStringField(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value === 'string') return value.trim()
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function marketIntField(row: Record<string, unknown>, key: string): number {
  const parsed = Number.parseInt(marketStringField(row, key).replaceAll(',', ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
