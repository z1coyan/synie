const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export type CanonicalDate = string & { readonly __brand: 'CanonicalDate' }
export type UtcEpochMilliseconds = number & { readonly __brand: 'UtcEpochMilliseconds' }

export function canonicalDate(value: string): CanonicalDate {
  const match = DATE_RE.exec(value)
  if (!match) throw new TypeError('日期必须是 YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const instant = new Date(Date.UTC(year, month - 1, day))
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    throw new TypeError('日期不是有效日历日')
  }
  return value as CanonicalDate
}

export function utcEpochMilliseconds(value: number): UtcEpochMilliseconds {
  if (!Number.isSafeInteger(value)) throw new TypeError('datetime 必须是安全整数毫秒')
  return value as UtcEpochMilliseconds
}

export function epochMillisecondsFromIso(value: string): UtcEpochMilliseconds {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError('datetime ISO 字符串必须显式携带 UTC/offset')
  }
  const epoch = Date.parse(value)
  if (!Number.isSafeInteger(epoch)) throw new TypeError('datetime ISO 字符串无效')
  return epoch as UtcEpochMilliseconds
}

export function isoFromEpochMilliseconds(value: number): string {
  return new Date(utcEpochMilliseconds(value)).toISOString()
}
