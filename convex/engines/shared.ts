import { INT64_MAX, INT64_MIN } from '../lib/decimal'
import { synieError } from '../lib/errors'

export function checkedAdd(left: bigint, right: bigint): bigint {
  const value = left + right
  if (value < INT64_MIN || value > INT64_MAX) throw synieError('validation', '定点数运算超出范围')
  return value
}

export function postingMonth(postingDate: string): string {
  return postingDate.slice(0, 7)
}

export function assertDateOnly(value: string, field = 'postingDate'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw synieError('validation', `${field} 必须是有效日期`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw synieError('validation', `${field} 必须是有效日期`)
  }
}
