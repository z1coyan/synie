export const ATTENDANCE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
export const MAX_ATTENDANCE_IMPORT_ROWS = 100_000

export interface ParsedAttendancePunch {
  attendanceNo: string
  punchedAt: Date
}

export interface ParsedAttendanceFile {
  rows: ParsedAttendancePunch[]
  totalRows: number
  badRows: number
  dupRows: number
}

/** Parse ZKTeco whitespace-delimited .dat wall-clock rows at fixed UTC+8. */
export function parseAttendanceFile(value: Uint8Array | string): ParsedAttendanceFile {
  const text = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: false }).decode(value)
  const nonblank = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((line) => line.trim())
  if (!nonblank.length) throw new Error('文件为空,未解析到打卡行')
  if (nonblank.length > MAX_ATTENDANCE_IMPORT_ROWS) {
    throw new Error(`文件超过 ${MAX_ATTENDANCE_IMPORT_ROWS} 行上限,请拆分后导入`)
  }
  const result: ParsedAttendanceFile = { rows: [], totalRows: nonblank.length, badRows: 0, dupRows: 0 }
  const seen = new Set<string>()
  for (const line of nonblank) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3 || !fields[0] || fields[0].length > 64) {
      result.badRows += 1
      continue
    }
    const localMs = Date.parse(`${fields[1]}T${fields[2]}Z`)
    if (!Number.isFinite(localMs)) {
      result.badRows += 1
      continue
    }
    const punchedAt = new Date(localMs - ATTENDANCE_UTC_OFFSET_MS)
    const key = `${fields[0]}\0${punchedAt.toISOString()}`
    if (seen.has(key)) {
      result.dupRows += 1
      continue
    }
    seen.add(key)
    result.rows.push({ attendanceNo: fields[0], punchedAt })
  }
  if (!result.rows.length) throw new Error(`未解析到有效打卡行(共 ${nonblank.length} 行均无法识别)`)
  return result
}

export function attendanceLocalDate(value: Date | number): string {
  const time = typeof value === 'number' ? value : value.getTime()
  return new Date(time + ATTENDANCE_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

export function unmatchedAttendanceDetail(counts: ReadonlyMap<string, number>): string | null {
  if (!counts.size) return null
  const keys = [...counts.keys()].sort()
  let value = keys.slice(0, 50).map((key) => `${key}×${counts.get(key)}`).join('、')
  if (keys.length > 50) value += `……(等共 ${keys.length} 个编号)`
  return value.slice(0, 2000)
}
