import type { MarketService, RefreshResult } from '~/modules/base/market/service.ts'
import type { SettingsService } from '~/platform/settings/service.ts'
import {
  decide,
  emptyScheduleState,
  type ScheduleState,
} from './decision.ts'

const INITIAL_DELAY_MS = 5_000
const TICK_INTERVAL_MS = 60_000

export interface MarketSchedulerDeps {
  settings: SettingsService
  market: MarketService
  /** 可注入时钟（测试）；默认 Date.now */
  now?: () => Date
  runLasts?: (now: Date) => Promise<RefreshResult>
  runSettlements?: (now: Date) => Promise<RefreshResult>
  log?: (level: 'info' | 'error', msg: string, extra?: Record<string, unknown>) => void
}

/**
 * 进程内行情定时调度：setInterval 形态，不引外部队列。
 * 单线程同步跑 tick（上一轮未完不并发）；stop() 优雅停机。
 */
export function createMarketScheduler(deps: MarketSchedulerDeps) {
  const nowFn = deps.now ?? (() => new Date())
  let state: ScheduleState = emptyScheduleState()
  let running = false
  let stopped = false
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  function log(
    level: 'info' | 'error',
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (deps.log) {
      deps.log(level, msg, extra)
      return
    }
    console.log(JSON.stringify({ level, msg, ...extra }))
  }

  async function tick(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      const setting = await deps.settings.loadSystemConfig()
      const now = truncateSecond(nowFn())
      const decision = decide(
        {
          scheduleEnabled: setting.marketFetchScheduleEnabled,
          lastIntervalMinutes: setting.marketFetchLastIntervalMinutes,
          settlementEnabled: setting.marketFetchSettlementEnabled,
        },
        now,
        state,
      )
      state = decision.next

      if (decision.runLasts) {
        log('info', '行情定时调度: 触发最新价拉取', { at: now.toISOString() })
        await runSafely('定时最新价', async () => {
          if (deps.runLasts) return deps.runLasts(now)
          return deps.market.refreshLasts(null, null, now)
        })
      }
      if (decision.runSettlements) {
        log('info', '行情定时调度: 触发结算价补拉', { at: now.toISOString() })
        await runSafely('定时结算价', async () => {
          if (deps.runSettlements) return deps.runSettlements(now)
          return deps.market.refreshSettlements(null, null, now)
        })
      }
    } catch (err) {
      log('error', '行情调度节拍失败', { error: String(err) })
    } finally {
      running = false
    }
  }

  async function runSafely(
    label: string,
    run: () => Promise<RefreshResult>,
  ): Promise<void> {
    try {
      const result = await run()
      for (const item of result.items) {
        log('info', '行情定时拉取条目', {
          code: item.code,
          kind: item.kind,
          status: item.status,
          message: item.message,
        })
      }
    } catch (err) {
      log('error', '行情定时调度运行失败', { label, error: String(err) })
      try {
        await deps.settings.recordMarketFetch(
          null,
          `${label}: 运行异常: ${err instanceof Error ? err.message : String(err)}`,
        )
      } catch (writeErr) {
        log('error', '行情定时调度失败摘要写回失败', {
          label,
          error: String(writeErr),
        })
      }
    }
  }

  function start(): void {
    if (initialTimer || tickTimer) return
    stopped = false
    initialTimer = setTimeout(() => {
      initialTimer = null
      void tick()
      if (stopped) return
      tickTimer = setInterval(() => {
        void tick()
      }, TICK_INTERVAL_MS)
    }, INITIAL_DELAY_MS)
  }

  function stop(): void {
    stopped = true
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  /** 测试用：同步跑一拍 */
  async function forceTick(): Promise<void> {
    await tick()
  }

  function getState(): ScheduleState {
    return { lasts: state.lasts, settlement: state.settlement }
  }

  function setState(next: ScheduleState): void {
    state = { lasts: next.lasts, settlement: next.settlement }
  }

  return { start, stop, forceTick, getState, setState }
}

export type MarketScheduler = ReturnType<typeof createMarketScheduler>

function truncateSecond(d: Date): Date {
  const x = new Date(d.getTime())
  x.setUTCMilliseconds(0)
  return x
}
