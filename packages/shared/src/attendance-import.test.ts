import { describe, expect, test } from 'bun:test'
import { parseAttendanceFile } from './attendance-import'

describe('attendance import parser', () => {
  test('keeps fixed UTC+8 and counts bad/duplicate rows', () => {
    const parsed = parseAttendanceFile('A01 2026-08-01 08:00:00\nA01 2026-08-01 08:00:00\nbad\n')
    expect(parsed.totalRows).toBe(3)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.dupRows).toBe(1)
    expect(parsed.badRows).toBe(1)
    expect(parsed.rows[0]?.punchedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  test('accepts exactly 100,000 and rejects 100,001 rows', () => {
    const row = 'A01 2026-08-01 08:00:00'
    const accepted = Array.from({ length: 100_000 }, (_, index) => `A01 2026-08-01 08:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60) % 60).padStart(2, '0')}`)
    expect(parseAttendanceFile(accepted.join('\n')).totalRows).toBe(100_000)
    expect(() => parseAttendanceFile(Array.from({ length: 100_001 }, () => row).join('\n'))).toThrow('100000 行上限')
  })
})
