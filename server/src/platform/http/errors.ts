import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiErrorBody, ApiErrorCode } from '@synie/shared'
import { API_ERROR_STATUS } from '@synie/shared'

/**
 * 统一错误模型（移植自 server-go platform/apierror）。
 * 业务代码 throw ApiError；onError 统一映射为 { error: { code, message, fields? } }。
 * 非 ApiError 一律 500 internal，message 固定不透出内部细节（细节进日志）。
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly fields?: Record<string, string[]>
  override readonly cause?: unknown

  constructor(code: ApiErrorCode, message: string, options?: { fields?: Record<string, string[]>; cause?: unknown }) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.fields = options?.fields
    this.cause = options?.cause
  }

  static validation(message: string, fields: Record<string, string[]>): ApiError {
    return new ApiError('validation', message, { fields })
  }

  get status(): number {
    return API_ERROR_STATUS[this.code]
  }
}

export function toErrorBody(err: unknown): { body: ApiErrorBody; status: number } {
  if (err instanceof ApiError) {
    const error: ApiErrorBody['error'] = { code: err.code, message: err.message }
    if (err.fields && Object.keys(err.fields).length > 0) {
      error.fields = err.fields
    }
    return { body: { error }, status: err.status }
  }
  return {
    body: { error: { code: 'internal', message: '服务内部错误，请稍后重试' } },
    status: 500,
  }
}

/** Hono onError：统一错误出口；内部错误带 requestId 落日志 */
export function onError(err: unknown, c: Context): Response {
  const { body, status } = toErrorBody(err)
  if (status >= 500) {
    console.error('unhandled error', {
      requestId: c.get('requestId'),
      path: c.req.path,
      err,
    })
  }
  return c.json(body, status as ContentfulStatusCode)
}

export function notFound(c: Context): Response {
  return c.json({ error: { code: 'not_found', message: '资源不存在' } } satisfies ApiErrorBody, 404)
}
