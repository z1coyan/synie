import { describe, expect, test } from 'bun:test'
import { decideFileClean, emptyFileCleanState } from './decision.ts'

/** 2026-08-08 周六；hour/minute 为上海墙钟 */
function shanghai(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 7, 8, hour - 8, minute, 0))
}

describe('decideFileClean', () => {
  test('到达每日时刻且当日未跑：触发并推进状态', () => {
    const d = decideFileClean({ enabled: true, runHour: 3 }, shanghai(3, 0), emptyFileCleanState())
    expect(d.shouldRun).toBe(true)
    expect(d.today).toBe('2026-08-08')
    expect(d.next.lastRunDate).toBe('2026-08-08')
  })

  test('当日已跑：不再触发', () => {
    const d = decideFileClean(
      { enabled: true, runHour: 3 },
      shanghai(10, 30),
      { lastRunDate: '2026-08-08' },
    )
    expect(d.shouldRun).toBe(false)
  })

  test('未到时刻：不触发', () => {
    const d = decideFileClean({ enabled: true, runHour: 3 }, shanghai(2, 59), emptyFileCleanState())
    expect(d.shouldRun).toBe(false)
    expect(d.next.lastRunDate).toBeNull()
  })

  test('错过时刻当日补跑（停机后重启）', () => {
    const d = decideFileClean({ enabled: true, runHour: 3 }, shanghai(9, 15), emptyFileCleanState())
    expect(d.shouldRun).toBe(true)
  })

  test('总开关关：不触发', () => {
    const d = decideFileClean({ enabled: false, runHour: 3 }, shanghai(3, 0), emptyFileCleanState())
    expect(d.shouldRun).toBe(false)
    expect(d.next.lastRunDate).toBeNull()
  })

  test('跨日再次触发', () => {
    const prev = { lastRunDate: '2026-08-08' }
    const nextDay = new Date(Date.UTC(2026, 7, 9, 3 - 8, 0, 0))
    const d = decideFileClean({ enabled: true, runHour: 3 }, nextDay, prev)
    expect(d.shouldRun).toBe(true)
    expect(d.today).toBe('2026-08-09')
  })
})
