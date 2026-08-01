import { describe, expect, test } from 'bun:test'
import { decide, emptyScheduleState, type MarketScheduleConfig } from './decision.ts'

/** 2026-07-17 周五；shanghai(h,m) → 对应 UTC */
function shanghai(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 6, 17, hour - 8, minute, 30))
}

function onConfig(over: Partial<MarketScheduleConfig> = {}): MarketScheduleConfig {
  return {
    scheduleEnabled: true,
    lastIntervalMinutes: 60,
    settlementEnabled: true,
    ...over,
  }
}

describe('marketsched decide', () => {
  test('定时总开关关不跑', () => {
    const cfg = onConfig({ scheduleEnabled: false })
    let d = decide(cfg, shanghai(9, 0), emptyScheduleState())
    expect(d.runLasts).toBe(false)
    expect(d.runSettlements).toBe(false)
    d = decide(cfg, shanghai(15, 30), emptyScheduleState())
    expect(d.runLasts).toBe(false)
    expect(d.runSettlements).toBe(false)
  })

  test('最新价槽位触发与去重', () => {
    const cases: Array<{
      name: string
      cfg?: Partial<MarketScheduleConfig>
      now: Date
      prev: ReturnType<typeof emptyScheduleState>
      want: boolean
    }> = [
      { name: '首次运行整点到槽', now: shanghai(9, 0), prev: emptyScheduleState(), want: true },
      { name: '槽内第1分钟容忍漂移', now: shanghai(9, 1), prev: emptyScheduleState(), want: true },
      { name: '槽内第2分钟不触发', now: shanghai(9, 2), prev: emptyScheduleState(), want: false },
      { name: '非槽位不触发', now: shanghai(9, 30), prev: emptyScheduleState(), want: false },
      {
        name: '同槽去重',
        now: shanghai(9, 0),
        prev: { lasts: { date: '2026-07-17', slot: 540 }, settlement: null },
        want: false,
      },
      {
        name: '下一槽再触发',
        now: shanghai(10, 0),
        prev: { lasts: { date: '2026-07-17', slot: 540 }, settlement: null },
        want: true,
      },
      { name: '日盘起点前不触发', now: shanghai(8, 0), prev: emptyScheduleState(), want: false },
      { name: '日盘末段 15:00 触发', now: shanghai(15, 0), prev: emptyScheduleState(), want: true },
      { name: '日盘结束后不触发', now: shanghai(16, 0), prev: emptyScheduleState(), want: false },
      { name: '夜盘 21:00 触发', now: shanghai(21, 0), prev: emptyScheduleState(), want: true },
      { name: '夜盘跨零点触发', now: shanghai(0, 0), prev: emptyScheduleState(), want: true },
      {
        name: '夜盘末尾 02:30 非槽位不触发',
        now: shanghai(2, 30),
        prev: emptyScheduleState(),
        want: false,
      },
      {
        name: '间隔30分半点槽触发',
        cfg: { lastIntervalMinutes: 30 },
        now: shanghai(9, 30),
        prev: emptyScheduleState(),
        want: true,
      },
      {
        name: '间隔120分两小时槽触发',
        cfg: { lastIntervalMinutes: 120 },
        now: shanghai(10, 0),
        prev: emptyScheduleState(),
        want: true,
      },
      {
        name: '间隔120分奇数点不触发',
        cfg: { lastIntervalMinutes: 120 },
        now: shanghai(9, 0),
        prev: emptyScheduleState(),
        want: false,
      },
      {
        name: '非法间隔按60分',
        cfg: { lastIntervalMinutes: 45 },
        now: shanghai(10, 0),
        prev: emptyScheduleState(),
        want: true,
      },
    ]
    for (const tc of cases) {
      const d = decide(onConfig(tc.cfg), tc.now, tc.prev)
      expect(d.runLasts, tc.name).toBe(tc.want)
    }
  })

  test('最新价状态前进', () => {
    const d = decide(onConfig(), shanghai(9, 0), emptyScheduleState())
    expect(d.runLasts).toBe(true)
    expect(d.next.lasts).toEqual({ date: '2026-07-17', slot: 540 })
  })

  test('结算槽位触发', () => {
    for (const [hour, minute, wantSlot] of [
      [15, 30, 930],
      [16, 0, 960],
      [16, 30, 990],
      [17, 0, 1020],
    ] as const) {
      const d = decide(onConfig(), shanghai(hour, minute), emptyScheduleState())
      expect(d.runSettlements).toBe(true)
      expect(d.next.settlement).toEqual({ date: '2026-07-17', slot: wantSlot })
    }
  })

  test('结算边界与开关', () => {
    const cases = [
      {
        name: '槽后1分钟容忍漂移',
        now: shanghai(15, 31),
        prev: emptyScheduleState(),
        cfg: {},
        want: true,
      },
      {
        name: '槽后2分钟不触发',
        now: shanghai(15, 32),
        prev: emptyScheduleState(),
        cfg: {},
        want: false,
      },
      {
        name: '槽前不触发',
        now: shanghai(15, 29),
        prev: emptyScheduleState(),
        cfg: {},
        want: false,
      },
      {
        name: '同槽去重',
        now: shanghai(15, 30),
        prev: { lasts: null, settlement: { date: '2026-07-17', slot: 930 } },
        cfg: {},
        want: false,
      },
      {
        name: '下一尝试槽重试',
        now: shanghai(16, 0),
        prev: { lasts: null, settlement: { date: '2026-07-17', slot: 930 } },
        cfg: {},
        want: true,
      },
      {
        name: '结算开关关不触发',
        now: shanghai(15, 30),
        prev: emptyScheduleState(),
        cfg: { settlementEnabled: false },
        want: false,
      },
    ] as const
    for (const tc of cases) {
      const d = decide(onConfig(tc.cfg), tc.now, tc.prev)
      expect(d.runSettlements, tc.name).toBe(tc.want)
    }
  })

  test('周末跳过结算', () => {
    // 2026-07-18 周六 15:30 上海 = 07:30 UTC
    const saturday = new Date(Date.UTC(2026, 6, 18, 7, 30, 0))
    expect(decide(onConfig(), saturday, emptyScheduleState()).runSettlements).toBe(false)
    const sunday = new Date(Date.UTC(2026, 6, 19, 7, 30, 0))
    expect(decide(onConfig(), sunday, emptyScheduleState()).runSettlements).toBe(false)
  })

  test('首次运行不在槽位不补跑', () => {
    const d = decide(onConfig(), shanghai(9, 45), emptyScheduleState())
    expect(d.runLasts).toBe(false)
    expect(d.runSettlements).toBe(false)
  })
})
