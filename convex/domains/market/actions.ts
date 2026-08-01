"use node"

import {
  MARKET_NOT_AVAILABLE,
  compactMarketError,
  marketQuotePrice,
  normalizeMarketLastSymbol,
  parseShfeMarketSettlement,
  parseSinaMarketLastBody,
  pastMarketSettlementWindow,
} from '@synie/shared'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action, internalAction } from '../../_generated/server'
import { synieError } from '../../lib/errors'

type Instrument = {
  id: string; code: string; name: string
  externalLastCode: string | null; externalProductGroup: string | null
}
type Plan = {
  mode: 'manual' | 'last' | 'settlement'; requestedAt: number
  settlementEnabled: boolean; instruments: Instrument[]
}
type Item = {
  instrumentId: string; code: string; name: string
  kind: 'last' | 'settlement'; status: 'ok' | 'skipped' | 'error'
  message: string; pricePointId: string | null
}

const currentUserRef = makeFunctionReference<'query', {}, { userId: string }>('files/domain:currentUserForAction')
const startRef = makeFunctionReference<'mutation', {
  userId: string; instrumentId?: string | null; requestedAt: number; token: string
}, any>('domains/market/domain:startManualRefresh')
const claimRef = makeFunctionReference<'mutation', { id: string; token: string; leaseMs?: number }, any>('jobs/domain:claim')
const planRef = makeFunctionReference<'query', { jobId: string; token: string }, Plan>('domains/market/domain:refreshPlan')
const ingestRef = makeFunctionReference<'mutation', {
  jobId: string; token: string; instrumentId: string; observedAt: number
  price: string; priceKind: string; note: string
}, any>('domains/market/domain:ingestFetchedPoint')
const finishRef = makeFunctionReference<'mutation', {
  jobId: string; token: string; items: Item[]; summary: string
}, any>('domains/market/domain:finishRefresh')
const failRef = makeFunctionReference<'mutation', {
  id: string; token: string; code: string; message: string
}, null>('jobs/domain:fail')

async function fetchResponse(url: string, referer: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('外部行情网络请求失败')
  }
}

async function fetchLast(code: string) {
  const symbol = normalizeMarketLastSymbol(code)
  const response = await fetchResponse(
    `https://hq.sinajs.cn/list=${encodeURIComponent(symbol)}`,
    'https://finance.sina.com.cn',
  )
  if (!response.ok) throw new Error(`新浪行情 HTTP ${response.status}`)
  return { quote: parseSinaMarketLastBody(await response.text(), symbol), symbol }
}

async function fetchSettlement(group: string, requestedAt: number) {
  const shanghai = new Date(requestedAt + 8 * 60 * 60 * 1000)
  const date = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()))
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const response = await fetchResponse(
    `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${y}${m}${d}.dat`,
    'https://www.shfe.com.cn/',
  )
  if (response.status === 404) throw MARKET_NOT_AVAILABLE
  if (!response.ok) throw new Error(`上期所日数据 HTTP ${response.status}`)
  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    throw new Error('上期所日数据 JSON 解析失败')
  }
  return { quote: parseShfeMarketSettlement(payload, group), date }
}

function item(instrument: Instrument, kind: Item['kind'], status: Item['status'], message: string, pricePointId: string | null): Item {
  return { instrumentId: instrument.id, code: instrument.code, name: instrument.name, kind, status, message, pricePointId }
}

function summary(plan: Plan, items: Item[]): string {
  const ok = items.filter((value) => value.status === 'ok').length
  const skipped = items.filter((value) => value.status === 'skipped').length
  const failed = items.filter((value) => value.status === 'error').length
  const label = plan.mode === 'manual' ? '手动刷新' : plan.mode === 'last' ? '定时最新价' : '定时结算价'
  return `${label}: 成功 ${ok},跳过 ${skipped},失败 ${failed}`
}

async function execute(ctx: any, jobId: string, token: string) {
  const plan = await ctx.runQuery(planRef, { jobId, token })
  const items: Item[] = []
  const doLast = plan.mode === 'manual' || plan.mode === 'last'
  const doSettlement = plan.mode === 'settlement' ||
    (plan.mode === 'manual' && plan.settlementEnabled && pastMarketSettlementWindow(new Date(plan.requestedAt)))
  for (const instrument of plan.instruments) {
    if (doLast) {
      if (!instrument.externalLastCode?.trim()) {
        items.push(item(instrument, 'last', 'error', '未配置外部最新价代码', null))
      } else {
        try {
          const { quote, symbol } = await fetchLast(instrument.externalLastCode)
          const result = await ctx.runMutation(ingestRef, {
            jobId, token, instrumentId: instrument.id,
            observedAt: Math.floor(plan.requestedAt / 60_000) * 60_000,
            price: marketQuotePrice(quote.price), priceKind: 'LAST',
            note: `sina ${symbol}${quote.asOfDate ? ` @${quote.asOfDate}` : ''}`,
          })
          items.push(item(instrument, 'last', result.status, result.message, result.pricePointId))
        } catch (error) {
          items.push(item(instrument, 'last', 'error', compactMarketError(error), null))
        }
      }
    }
    if (doSettlement) {
      if (!instrument.externalProductGroup?.trim()) {
        items.push(item(instrument, 'settlement', 'error', '未配置外部品种组', null))
      } else {
        try {
          const group = instrument.externalProductGroup.trim()
          const { quote, date } = await fetchSettlement(group, plan.requestedAt)
          const result = await ctx.runMutation(ingestRef, {
            jobId, token, instrumentId: instrument.id,
            observedAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 7),
            price: marketQuotePrice(quote.price), priceKind: 'SETTLEMENT',
            note: `shfe ${group}${quote.deliveryMonth} main OI=${quote.openInterest}`,
          })
          items.push(item(instrument, 'settlement', result.status, result.message, result.pricePointId))
        } catch (error) {
          items.push(item(instrument, 'settlement', error === MARKET_NOT_AVAILABLE ? 'skipped' : 'error',
            error === MARKET_NOT_AVAILABLE ? '日数据尚未发布或非交易日' : compactMarketError(error), null))
        }
      }
    }
  }
  const text = summary(plan, items)
  if (plan.mode !== 'manual' && items.some((value) => value.status === 'error')) {
    await ctx.runMutation(failRef, { id: jobId, token, code: 'market_provider', message: text })
    throw new Error(text)
  }
  return ctx.runMutation(finishRef, { jobId, token, items, summary: text })
}

export const refresh = action({
  args: { instrumentId: v.optional(v.union(v.string(), v.null())) }, returns: v.any(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    const token = crypto.randomUUID()
    const started = await ctx.runMutation(startRef, {
      userId, instrumentId: args.instrumentId ?? null, requestedAt: Date.now(), token,
    })
    if (started.completed) return started.result
    return execute(ctx, started.jobId, token)
  },
})

/** Cron/job runner entry: args contain only the durable job id. */
export const runQueued = internalAction({
  args: { jobId: v.id('ioJobs') }, returns: v.any(),
  handler: async (ctx, args) => {
    const token = crypto.randomUUID()
    const claimed = await ctx.runMutation(claimRef, { id: args.jobId, token, leaseMs: 5 * 60_000 })
    if (claimed.status !== 'running') return null
    try {
      return await execute(ctx, String(args.jobId), token)
    } catch (error) {
      const message = error instanceof Error ? error.message : '行情刷新失败'
      await ctx.runMutation(failRef, { id: args.jobId, token, code: 'market_refresh', message }).catch(() => undefined)
      throw synieError('internal', '行情刷新任务暂时失败,后台将继续重试')
    }
  },
})
