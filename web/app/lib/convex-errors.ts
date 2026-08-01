import { AppError } from './errors'

export const SYNIE_ERROR_CODES = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
] as const

export type SynieErrorCode = (typeof SYNIE_ERROR_CODES)[number]

export interface SynieErrorData {
  code: SynieErrorCode
  message: string
  fields?: Record<string, string[]>
}

const errorCodes = new Set<string>(SYNIE_ERROR_CODES)

function isFieldErrors(value: unknown): value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every(
    (messages) =>
      Array.isArray(messages) &&
      messages.every((message) => typeof message === 'string'),
  )
}

export function synieErrorData(error: unknown): SynieErrorData | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null
  }
  const data = error.data
  if (
    typeof data !== 'object' ||
    data === null ||
    !('code' in data) ||
    typeof data.code !== 'string' ||
    !errorCodes.has(data.code) ||
    !('message' in data) ||
    typeof data.message !== 'string'
  ) {
    return null
  }
  const fields = 'fields' in data ? data.fields : undefined
  if (fields !== undefined && !isFieldErrors(fields)) return null
  return {
    code: data.code as SynieErrorCode,
    message: data.message,
    ...(fields ? { fields } : {}),
  }
}

export class ConvexAppError extends AppError {
  readonly code: SynieErrorCode
  readonly fields?: Record<string, string[]>

  constructor(data: SynieErrorData, options?: ErrorOptions) {
    super(
      data.code === 'forbidden'
        ? '无权限访问,请联系管理员分配权限'
        : data.message,
      [data.code],
      options,
    )
    this.name = 'ConvexAppError'
    this.code = data.code
    this.fields = data.fields
  }
}

/** 未知错误使用固定中文文案，绝不把内部 message/stack 带进 toast。 */
export function mapConvexError(
  error: unknown,
  fallback = '请求失败,请稍后再试',
): ConvexAppError {
  const data = synieErrorData(error)
  return new ConvexAppError(
    data ?? { code: 'internal', message: fallback },
    error instanceof Error ? { cause: error } : undefined,
  )
}
