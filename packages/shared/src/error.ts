/**
 * 统一错误模型（对齐 server-go platform/apierror 与 contracts/openapi 错误响应）：
 * { "error": { "code", "message", "fields"? } }
 * message 为中文用户可读；fields 仅 validation 时携带（字段名 → 错误列表）。
 */
export const API_ERROR_CODES = [
  'unauthorized',
  'rate_limited',
  'forbidden',
  'validation',
  'not_found',
  'conflict',
  'not_implemented',
  'internal',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode
    message: string
    fields?: Record<string, string[]>
  }
}

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  rate_limited: 429,
  forbidden: 403,
  validation: 400,
  not_found: 404,
  conflict: 409,
  not_implemented: 501,
  internal: 500,
}
