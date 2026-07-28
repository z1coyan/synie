import { decimal, toDecimalString, type Decimal } from '@synie/shared'

export interface LastQuote {
  price: Decimal
  asOfDate: string | null
}

export interface SettlementQuote {
  price: Decimal
  deliveryMonth: string
  openInterest: number
}

export interface LastPriceClient {
  fetchLast(code: string): Promise<LastQuote>
}

export interface SettlementPriceClient {
  fetchSettlement(group: string, tradeDate: Date): Promise<SettlementQuote>
}

export const ERR_NOT_AVAILABLE = new Error('not available')

/** 上海时区 ≥ 15:30 视为进入结算窗口（固定 UTC+8，无夏令时） */
export function pastSettlementWindow(now: Date): boolean {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes() >= 15 * 60 + 30
}

export function createPublicMarketClient(httpTimeoutMs = 15_000): LastPriceClient &
  SettlementPriceClient {
  async function fetchLast(code: string): Promise<LastQuote> {
    let symbol = code.trim()
    if (!symbol.startsWith('nf_')) symbol = `nf_${symbol}`
    const url = `https://hq.sinajs.cn/list=${encodeURIComponent(symbol)}`
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://finance.sina.com.cn',
        },
        signal: AbortSignal.timeout(httpTimeoutMs),
      })
    } catch (err) {
      throw new Error(`新浪行情网络错误:${String(err)}`)
    }
    if (!response.ok) throw new Error(`新浪行情 HTTP ${response.status}`)
    const body = await response.text()
    const pattern = new RegExp(`hq_str_${escapeRegExp(symbol)}="([^"]*)"`)
    const match = pattern.exec(body)
    if (!match?.[1]) throw new Error(`新浪行情无数据(${symbol})`)
    const parts = match[1].split(',')
    if (parts.length <= 8) throw new Error('新浪行情缺少最新价')
    const raw = (parts[8] ?? '').trim()
    let price: Decimal
    try {
      price = decimal(raw)
    } catch {
      throw new Error('新浪最新价无效')
    }
    if (!price.greaterThan(0)) throw new Error('新浪最新价无效')
    const asOf = parts.length > 17 && (parts[17] ?? '').trim() !== '' ? (parts[17] ?? '').trim() : null
    return { price, asOfDate: asOf }
  }

  async function fetchSettlement(group: string, tradeDate: Date): Promise<SettlementQuote> {
    const y = tradeDate.getUTCFullYear()
    const m = String(tradeDate.getUTCMonth() + 1).padStart(2, '0')
    const d = String(tradeDate.getUTCDate()).padStart(2, '0')
    const endpoint = `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${y}${m}${d}.dat`
    let response: Response
    try {
      response = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.shfe.com.cn/',
        },
        signal: AbortSignal.timeout(httpTimeoutMs),
      })
    } catch (err) {
      throw new Error(`上期所日数据网络错误:${String(err)}`)
    }
    if (response.status === 404) throw ERR_NOT_AVAILABLE
    if (!response.ok) throw new Error(`上期所日数据 HTTP ${response.status}`)
    let payload: Record<string, unknown>
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      throw new Error('上期所日数据 JSON 解析失败')
    }
    const rows = Array.isArray(payload.o_curinstrument) ? payload.o_curinstrument : []
    const target = group.trim().toLowerCase()
    let best: SettlementQuote | null = null
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      let product = stringField(row, 'PRODUCTGROUPID').toLowerCase()
      if (!product) product = stringField(row, 'PRODUCTID').toLowerCase()
      const month = stringField(row, 'DELIVERYMONTH')
      const priceRaw = stringField(row, 'SETTLEMENTPRICE')
      let price: Decimal
      try {
        price = decimal(priceRaw)
      } catch {
        continue
      }
      if (product !== target || !month || !price.greaterThan(0)) continue
      const openInterest = intField(row, 'OPENINTEREST')
      if (!best || openInterest > best.openInterest) {
        best = { price, deliveryMonth: month, openInterest }
      }
    }
    if (!best) throw new Error(`上期所日数据无品种组 ${group} 的合约`)
    return best
  }

  return { fetchLast, fetchSettlement }
}

export function compactError(err: unknown): string {
  const value = String(err instanceof Error ? err.message : err)
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
  const runes = [...value]
  return runes.length > 200 ? runes.slice(0, 200).join('') : value
}

/** 测试辅助：格式化定点价格字符串 */
export function quotePriceString(price: Decimal): string {
  return toDecimalString(price)
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return ''
}

function intField(row: Record<string, unknown>, key: string): number {
  const raw = stringField(row, key).replaceAll(',', '')
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
