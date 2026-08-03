/**
 * HR service 共享小工具（日期/金额/写错映射）。
 */
import { decimal, isDecimalString, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import { mapWriteError } from '~/db/dberr.ts'
import { ApiError } from '~/platform/http/errors.ts'

const GENERIC_WRITE = [
  { code: '23505', message: '记录违反唯一约束' },
  { code: '23503', message: '记录已被引用或引用对象不存在' },
] as const

export function writeErr(err: unknown, message: string): ApiError {
  return mapWriteError(err, message, GENERIC_WRITE)
}

export function numStr(value: unknown): string {
  if (value == null) return '0'
  return toDecimalString(decimal(String(value)))
}

export function nullableNumStr(value: unknown): string | null {
  if (value == null) return null
  return decimal(String(value)).toFixed()
}

export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function asDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10)
  }
  return value.toISOString().slice(0, 10)
}

export function toTs(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
}

/**
 * postgres.js 会把 timestamp 参数按本地时区重解；经 text 再 cast 可保留 UTC 墙钟字面量。
 * 见 https://github.com/porsager/postgres 对 timestamp without time zone 的序列化行为。
 */
export function tsParam(value: Date) {
  return sql`${toTs(value)}::text::timestamp`
}

export function parseDate(value: string, field: string): Date {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))) {
    throw ApiError.validation('日期参数不合法', { [field]: ['格式应为 YYYY-MM-DD'] })
  }
  return new Date(`${trimmed}T00:00:00Z`)
}

export function parseMonth(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw ApiError.validation('月份参数不合法', { month: ['格式应为 YYYY-MM'] })
  }
  return `${value}-01`
}

export function addMonth(firstOfMonth: string): string {
  const d = new Date(`${firstOfMonth}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

export function parseDecimal(
  value: string,
  field: string,
  nonnegative: boolean,
  nonzero: boolean,
): ReturnType<typeof decimal> {
  const trimmed = value.trim()
  if (!isDecimalString(trimmed)) {
    throw ApiError.validation('数值参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  const parsed = decimal(trimmed)
  if (nonnegative && parsed.isNegative()) {
    throw ApiError.validation('数值参数不合法', { [field]: ['不能为负数'] })
  }
  if (nonzero && parsed.isZero()) {
    throw ApiError.validation('数值参数不合法', { [field]: ['不能为零'] })
  }
  return parsed
}
