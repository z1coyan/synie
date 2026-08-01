import { ConvexError } from 'convex/values'

export type SynieErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'

export type SynieErrorData = {
  code: SynieErrorCode
  message: string
  fields?: Record<string, string[]>
}

export function synieError(
  code: SynieErrorCode,
  message: string,
  fields?: Record<string, string[]>,
): ConvexError<SynieErrorData> {
  return new ConvexError(fields ? { code, message, fields } : { code, message })
}

export function validationError(
  message: string,
  fields: Record<string, string[]>,
): ConvexError<SynieErrorData> {
  return synieError('validation', message, fields)
}

export function publicInternalError(correlationId: string): ConvexError<SynieErrorData> {
  return synieError('internal', `系统内部错误（关联编号：${correlationId}）`)
}
