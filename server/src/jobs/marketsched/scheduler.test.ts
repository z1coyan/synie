import { describe, expect, test } from 'bun:test'
import type { SystemSetting } from '~/platform/settings/service.ts'
import type { RefreshResult } from '~/modules/base/market/service.ts'
import { createMarketScheduler } from './scheduler.ts'
import { emptyScheduleState } from './decision.ts'

function shanghai(hour: number, minute: number): Date {
  // 2026-07-17 周五
  return new Date(Date.UTC(2026, 6, 17, hour - 8, minute, 0))
}

function fakeSettings(over: Partial<SystemSetting> = {}) {
  const base: SystemSetting = {
    id: 'sys',
    marketFetchScheduleEnabled: true,
    marketFetchLastIntervalMinutes: 60,
    marketFetchSettlementEnabled: true,
    marketFetchLastRunAt: null,
    marketFetchLastSummary: null,
    insertedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
  const summaries: string[] = []
  return {
    service: {
      loadSystemConfig: async () => base,
      recordMarketFetch: async (_actor: unknown, summary: string) => {
        summaries.push(summary)
        base.marketFetchLastSummary = summary
        base.marketFetchLastRunAt = new Date()
        return base
      },
    } as never,
    summaries,
    set(partial: Partial<SystemSetting>) {
      Object.assign(base, partial)
    },
  }
}

describe('createMarketScheduler 可注入时钟', () => {
  test('日盘整点槽触发最新价 runner，并前进 state', async () => {
    const settings = fakeSettings()
    const lastsCalls: Date[] = []
    const settlementCalls: Date[] = []
    let clock = shanghai(9, 0)

    const scheduler = createMarketScheduler({
      settings: settings.service,
      market: {} as never,
      now: () => clock,
      runLasts: async (now) => {
        lastsCalls.push(now)
        return { items: [], count: 0 } satisfies RefreshResult
      },
      runSettlements: async (now) => {
        settlementCalls.push(now)
        return { items: [], count: 0 }
      },
      log: () => {},
    })

    await scheduler.forceTick()
    expect(lastsCalls).toHaveLength(1)
    expect(settlementCalls).toHaveLength(0)
    expect(scheduler.getState().lasts).toEqual({ date: '2026-07-17', slot: 540 })

    // 同槽再 tick 不重复
    clock = shanghai(9, 1)
    await scheduler.forceTick()
    expect(lastsCalls).toHaveLength(1)
  })

  test('结算槽触发结算 runner', async () => {
    const settings = fakeSettings()
    const settlementCalls: Date[] = []
    const clock = shanghai(15, 30)

    const scheduler = createMarketScheduler({
      settings: settings.service,
      market: {} as never,
      now: () => clock,
      runLasts: async () => ({ items: [], count: 0 }),
      runSettlements: async (now) => {
        settlementCalls.push(now)
        return {
          items: [
            {
              instrumentId: 'x',
              code: 'T',
              kind: 'settlement',
              status: 'ok',
              message: null,
              pricePointId: 'p',
            },
          ],
          count: 1,
        }
      },
      log: () => {},
    })

    await scheduler.forceTick()
    expect(settlementCalls).toHaveLength(1)
    expect(scheduler.getState().settlement).toEqual({ date: '2026-07-17', slot: 930 })
  })

  test('总开关关不触发任何 runner', async () => {
    const settings = fakeSettings({ marketFetchScheduleEnabled: false })
    let called = false
    const scheduler = createMarketScheduler({
      settings: settings.service,
      market: {} as never,
      now: () => shanghai(9, 0),
      runLasts: async () => {
        called = true
        return { items: [], count: 0 }
      },
      runSettlements: async () => {
        called = true
        return { items: [], count: 0 }
      },
      log: () => {},
    })
    await scheduler.forceTick()
    expect(called).toBe(false)
    expect(scheduler.getState()).toEqual(emptyScheduleState())
  })

  test('runner 抛错写失败摘要', async () => {
    const settings = fakeSettings()
    const scheduler = createMarketScheduler({
      settings: settings.service,
      market: {} as never,
      now: () => shanghai(9, 0),
      runLasts: async () => {
        throw new Error('boom')
      },
      log: () => {},
    })
    await scheduler.forceTick()
    expect(settings.summaries.some((s) => s.includes('定时最新价') && s.includes('boom'))).toBe(
      true,
    )
  })

  test('stop 后 forceTick 不再执行', async () => {
    const settings = fakeSettings()
    let n = 0
    const scheduler = createMarketScheduler({
      settings: settings.service,
      market: {} as never,
      now: () => shanghai(9, 0),
      runLasts: async () => {
        n++
        return { items: [], count: 0 }
      },
      log: () => {},
    })
    scheduler.stop()
    await scheduler.forceTick()
    expect(n).toBe(0)
  })
})
