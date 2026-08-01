import { synieError, validationError } from './errors'

export function assertExists<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw synieError('not_found', `${label}不存在`)
  return value
}

export function assertUniqueByIndex(value: unknown, label: string): void {
  if (value != null) throw synieError('conflict', `${label}已存在`)
}

export function assertDeleteAllowed(blocked: boolean, message: string): void {
  if (blocked) throw synieError('conflict', message)
}

export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw validationError('参数不合法', { [field]: ['值不在允许范围内'] })
  }
}

export function assertRange(
  value: bigint,
  options: { min?: bigint; max?: bigint; field: string },
): void {
  if (
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) {
    throw validationError('参数不合法', { [options.field]: ['超出允许范围'] })
  }
}

export function assertCheck(
  condition: unknown,
  field: string,
  message: string,
): asserts condition {
  if (!condition) throw validationError('参数不合法', { [field]: [message] })
}
