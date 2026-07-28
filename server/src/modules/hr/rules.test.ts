import { describe, expect, test } from 'bun:test'
import {
  computeAttendanceDay,
  parseAttendanceFile,
  unmatchedDetail,
} from './rules.ts'

describe('parseAttendanceFile', () => {
  test('解析空格/制表符、坏行与文件内重复', () => {
    const parsed = parseAttendanceFile(
      '001 2026-07-01 08:01:01 0 0\n' +
        '001\t2026-07-01\t08:01:01\n' +
        '001 2026-07-01 12:00:00\n' +
        'bad\n',
    )
    expect(parsed.totalRows).toBe(4)
    expect(parsed.badRows).toBe(1)
    expect(parsed.dupRows).toBe(1)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]!.attendanceNo).toBe('001')
    // 本地 08:01:01 → UTC 00:01:01
    expect(parsed.rows[0]!.punchedAt.toISOString()).toBe('2026-07-01T00:01:01.000Z')
  })

  test('全坏文件抛可读错误', () => {
    expect(() => parseAttendanceFile('BAD-LINE\nalso bad')).toThrow(
      /共 2 行均无法识别/,
    )
  })

  test('空文件抛错', () => {
    expect(() => parseAttendanceFile('\n\n')).toThrow(/文件为空/)
  })
})

describe('computeAttendanceDay', () => {
  test('半天桶/取整/加班/奖励工日/缺卡', () => {
    const day = computeAttendanceDay(['07:59:59', '12:00:00', '16:00:00', '19:31:00'])
    expect(day.normalHours).toBe('4')
    expect(day.overtimeHours).toBe('3.5')
    expect(day.bonusWorkday).toBe('0.5')
    expect(day.status).toBe('missing')
    expect(day.morningIn).toBe('07:59:59')
  })

  test('导入验收边界：上午 08:01-11:59 + 下午 13:00-20:31', () => {
    const day = computeAttendanceDay([
      '08:01:00',
      '11:59:00',
      '13:00:00',
      '20:31:00',
    ])
    expect(day.morningIn).toBe('08:01:00')
    expect(day.morningOut).toBe('11:59:00')
    expect(day.afternoonIn).toBe('13:00:00')
    expect(day.afternoonOut).toBe('20:31:00')
    expect(day.normalHours).toBe('7.5')
    expect(day.overtimeHours).toBe('3.5')
    expect(day.bonusWorkday).toBe('0.5')
    expect(day.status).toBe('ok')
  })

  test('补卡单：上午单卡 → 缺卡 + 下午加班', () => {
    const day = computeAttendanceDay(['08:10:59', '12:00:00', '17:45:00'])
    expect(day.status).toBe('missing')
    expect(day.normalHours).toBe('4')
    expect(day.overtimeHours).toBe('1.5')
    expect(day.bonusWorkday).toBe('0')
  })

  test('标准全天无加班', () => {
    // 12:00 归下午桶；上午用 08:00–11:59
    const day = computeAttendanceDay(['08:00:00', '11:59:00', '13:00:00', '17:00:00'])
    expect(day.normalHours).toBe('7.5')
    expect(day.overtimeHours).toBe('0')
    expect(day.bonusWorkday).toBe('0')
    expect(day.status).toBe('ok')
  })
})

describe('unmatchedDetail', () => {
  test('汇总未匹配编号', () => {
    const detail = unmatchedDetail(
      [
        { attendanceNo: 'b', punchedAt: new Date() },
        { attendanceNo: 'a', punchedAt: new Date() },
        { attendanceNo: 'a', punchedAt: new Date() },
      ],
      new Map([['x', 'id']]),
    )
    expect(detail).toBe('a×2、b×1')
  })

  test('全部匹配返回 null', () => {
    const detail = unmatchedDetail(
      [{ attendanceNo: 'a', punchedAt: new Date() }],
      new Map([['a', 'id']]),
    )
    expect(detail).toBeNull()
  })
})
