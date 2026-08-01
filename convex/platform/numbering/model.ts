import { synieError } from '../../lib/errors'
import type { NumberingField } from './catalog'

export type NumberingSegment =
  | { kind: 'text'; value: string }
  | { kind: 'sequence'; padding: number }
  | { kind: 'field'; field: string; format?: string }

const DATE_FORMAT_RE = /^(?:YYYY|YY|MM|DD)+$/

export function validateSegments(
  segments: readonly NumberingSegment[],
  fields: Readonly<Record<string, NumberingField>>,
): void {
  let sequenceCount = 0
  if (segments.length === 0) throw synieError('validation', '至少需要一个编号段')
  for (const segment of segments) {
    if (segment.kind === 'text' && !segment.value) throw synieError('validation', '固定文本段不能为空')
    if (segment.kind === 'sequence') {
      sequenceCount += 1
      if (!Number.isInteger(segment.padding) || segment.padding < 0 || segment.padding > 12) {
        throw synieError('validation', '序号位数须在 0~12 之间(0=不补零)')
      }
    }
    if (segment.kind === 'field') {
      const field = fields[segment.field]
      if (!field) throw synieError('validation', `编号字段 ${segment.field} 在绑定资源上不存在`)
      const isDate = field.type === 'date' || field.type === 'datetime'
      if (isDate && (!segment.format || !DATE_FORMAT_RE.test(segment.format))) {
        throw synieError('validation', `日期字段 ${segment.field} 须选择格式(YYYY/YY/MM/DD 组合)`)
      }
      if (!isDate && segment.format) throw synieError('validation', `字段 ${segment.field} 不是日期,不能设格式`)
    }
  }
  if (sequenceCount !== 1) throw synieError('validation', '序号段必须恰好一个')
}

export function renderDate(value: unknown, format: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    throw synieError('validation', '编号日期字段值不合法')
  }
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value)
  if (Number.isNaN(date.getTime())) throw synieError('validation', '编号日期字段值不合法')
  return format
    .replaceAll('YYYY', String(date.getUTCFullYear()))
    .replaceAll('YY', String(date.getUTCFullYear()).slice(-2))
    .replaceAll('MM', String(date.getUTCMonth() + 1).padStart(2, '0'))
    .replaceAll('DD', String(date.getUTCDate()).padStart(2, '0'))
}

export function renderNumber(
  parts: readonly ({ text: string } | { sequence: true; padding: number })[],
  sequence: bigint,
): string {
  return parts
    .map((part) => {
      if ('text' in part) return part.text
      const raw = sequence.toString()
      return part.padding > raw.length ? raw.padStart(part.padding, '0') : raw
    })
    .join('')
}
