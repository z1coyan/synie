/**
 * 业务日日期口径：YYYY-MM-DD（UTC 组件）。
 * 引擎与业务模块共用的唯一事实源。
 */

/** 业务日 → YYYY-MM-DD（UTC 组件，对齐 Go pgtype.Date / UTC fixture） */
export function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.trim().slice(0, 10)
  }
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 当前 UTC 业务日 */
export function utcToday(): string {
  return toDateOnly(new Date())
}

/** DB 日期/时间戳值 → Date（pg 驱动按驱动版本返回 Date 或字符串，统一在此收敛） */
export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
