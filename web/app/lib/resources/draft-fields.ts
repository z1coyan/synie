/**
 * 聚合草稿 build 函数的字段基元：表单态 → wire 的空值/必填/序号收敛。
 * 各 *-draft module 与单据抽屉共用唯一实现，不再各自复刻。
 */

export function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

export function requiredString(value: unknown, label: string): string {
  const result = nullableString(value)
  if (result == null) throw new Error(`${label}不能为空`)
  return result
}

export function requiredIndex(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isInteger(result)) throw new Error(`${label}必须是整数`)
  return result
}
