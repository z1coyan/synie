import { Decimal } from '@synie/shared'

const HALF_HOUR_MS = 30 * 60 * 1_000

function format(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${part(Math.floor(seconds / 3_600))}:${part(Math.floor((seconds % 3_600) / 60))}:${part(seconds % 60)}`
}

function bounds(values: number[]): [string | null, string | null] {
  return values.length ? [format(values[0]!), format(values[values.length - 1]!)] : [null, null]
}

function units(values: number[]): number {
  return values.length < 2 ? 0 : Math.floor((values[values.length - 1]! - values[0]!) / HALF_HOUR_MS)
}

export function computeAttendanceDay(values: readonly string[]) {
  const morning: number[] = []
  const afternoon: number[] = []
  for (const value of values) {
    const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (!match) throw new Error(`解析日考勤时刻失败: ${value}`)
    const hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3])
    if (hour > 23 || minute > 59 || second > 59) throw new Error(`解析日考勤时刻失败: ${value}`)
    const target = hour < 12 ? morning : afternoon
    target.push(((hour * 60 + minute) * 60 + second) * 1_000)
  }
  morning.sort((a, b) => a - b); afternoon.sort((a, b) => a - b)
  const [morningIn, morningOut] = bounds(morning)
  const [afternoonIn, afternoonOut] = bounds(afternoon)
  const morningUnits = Math.min(units(morning), 8)
  const afternoonUnits = units(afternoon)
  const overtimeUnits = Math.max(afternoonUnits - 8, 0)
  return {
    morningIn, morningOut, afternoonIn, afternoonOut,
    normalHours: new Decimal(morningUnits + Math.min(afternoonUnits, 8)).div(2).toString(),
    overtimeHours: new Decimal(overtimeUnits).div(2).toString(),
    bonusWorkday: overtimeUnits >= 7 ? '0.5' : '0',
    status: morning.length === 1 || afternoon.length === 1 ? 'MISSING' : 'OK',
  }
}
