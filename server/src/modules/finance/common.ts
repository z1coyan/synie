/**
 * 财务运营公共辅助：校验/大小写/日期/金额/审计快照。
 */
import { decimal, isDecimalString, toDecimalString } from '@synie/shared'
import { hasPermission, canAccessCompany, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'

export function lower(value: string): string {
  return value.trim().toLowerCase()
}

export function upper(value: string): string {
  return value.trim().toUpperCase()
}

export function actorUserId(actor: Actor): string | null {
  return actor.userId && actor.userId !== '' ? actor.userId : null
}

export function requirePerm(actor: Actor, code: string, message = '无权限执行此操作'): void {
  if (!hasPermission(actor, code)) {
    throw new ApiError('forbidden', message)
  }
}

export function requireCompanyAccess(
  actor: Actor,
  companyId: string,
  label: string,
): void {
  if (!canAccessCompany(actor, companyId)) {
    throw new ApiError('not_found', `${label}不存在`)
  }
}

export function requireCompanyWrite(actor: Actor, companyId: string): void {
  if (!canAccessCompany(actor, companyId)) {
    throw new ApiError('forbidden', '无权操作该公司数据')
  }
}

export function notFound(label: string): ApiError {
  return new ApiError('not_found', `${label}不存在`)
}

export function conflict(message: string): ApiError {
  return new ApiError('conflict', message)
}

export function validation(label: string, fields: Record<string, string[]>): ApiError {
  return ApiError.validation(`${label}参数不合法`, fields)
}

export function validateRequiredText(
  fields: Record<string, string[]>,
  field: string,
  value: string,
  max: number,
): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    fields[field] = ['必填']
  } else if ([...trimmed].length > max) {
    fields[field] = [`最多 ${max} 个字符`]
  }
  return trimmed
}

export function validateOptionalText(
  fields: Record<string, string[]>,
  field: string,
  value: string | null | undefined,
  max: number,
): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if ([...trimmed].length > max) {
    fields[field] = [`最多 ${max} 个字符`]
  }
  return trimmed
}

export function requireDate(value: string, field: string): string {
  const v = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw ApiError.validation('日期参数不合法', {
      [field]: ['格式应为 YYYY-MM-DD'],
    })
  }
  // 日历合法性
  const [y, m, d] = v.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw ApiError.validation('日期参数不合法', {
      [field]: ['格式应为 YYYY-MM-DD'],
    })
  }
  return v
}

export function optionalDate(value: string | null | undefined, field: string): string | null {
  if (value == null || value.trim() === '') return null
  return requireDate(value, field)
}

export function parseDecimal(
  value: string,
  field: string,
  positive: boolean,
  nonnegative: boolean,
) {
  const trimmed = value.trim()
  if (!isDecimalString(trimmed)) {
    throw ApiError.validation('数值参数不合法', {
      [field]: ['必须是十进制字符串'],
    })
  }
  const d = decimal(trimmed)
  if (positive && !d.gt(0)) {
    throw ApiError.validation('数值参数不合法', { [field]: ['必须大于零'] })
  }
  if (nonnegative && d.isNegative()) {
    throw ApiError.validation('数值参数不合法', { [field]: ['不能为负数'] })
  }
  return d
}

export function parseOptionalDecimal(
  value: string | null | undefined,
  field: string,
  positive: boolean,
  nonnegative: boolean,
) {
  if (value == null) return null
  return parseDecimal(value, field, positive, nonnegative)
}

export function wireDec(value: unknown): string | null {
  if (value == null || value === '') return null
  return toDecimalString(decimal(String(value)))
}

export function wireDecRequired(value: unknown): string {
  if (value == null || value === '') return '0'
  return toDecimalString(decimal(String(value)))
}

export function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

export function asIsoOrNull(value: unknown): string | null {
  if (value == null) return null
  return asIso(value)
}

export function asDateOnly(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }
  return String(value).slice(0, 10)
}

export function asDateOnlyOrNull(value: unknown): string | null {
  if (value == null) return null
  const s = asDateOnly(value)
  return s === '' ? null : s
}

export function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t === '' ? null : t
}

export function truncateRunes(value: string, max: number): string {
  const runes = [...value]
  if (runes.length <= max) return value
  return runes.slice(0, max).join('')
}

export function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

/** 将 DB 枚举（小写）规范为 wire 大写 */
export function wireEnum(value: unknown): string {
  return upper(String(value ?? ''))
}
