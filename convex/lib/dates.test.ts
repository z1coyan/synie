import { describe, expect, test } from 'bun:test'
import {
  canonicalDate,
  epochMillisecondsFromIso,
  isoFromEpochMilliseconds,
  utcEpochMilliseconds,
} from './dates'

describe('date/datetime codec', () => {
  test('日期只接受真实 YYYY-MM-DD 日历日', () => {
    expect(canonicalDate('2024-02-29')).toBe('2024-02-29')
    expect(() => canonicalDate('2023-02-29')).toThrow()
    expect(() => canonicalDate('2026-7-1')).toThrow()
  })

  test('datetime 只存 UTC epoch milliseconds，不猜本地时区', () => {
    const epoch = epochMillisecondsFromIso('2026-07-31T23:59:59.123+08:00')
    expect(isoFromEpochMilliseconds(epoch)).toBe('2026-07-31T15:59:59.123Z')
    expect(() => epochMillisecondsFromIso('2026-07-31T23:59:59')).toThrow()
    expect(() => utcEpochMilliseconds(1.5)).toThrow()
  })
})
