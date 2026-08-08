import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiErrorBody, ApiErrorCode } from '@synie/shared'
import { API_ERROR_STATUS } from '@synie/shared'
import { logJson, serializeError } from './log.ts'
import type { ErrorReporter } from './error-report.ts'

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

/** 外发摘要最大长度（防超长堆栈式 message 打到 webhook） */
const ERROR_SUMMARY_MAX = 200

/**
 * 外发摘要：ApiError 的 message 是面向用户的可外发；未知错误只发类型名——
 * 内部细节（堆栈/PG 字段）留本地日志，防敏感外泄。
 */
function summarizeForReport(err: unknown): string {
  const text =
    err instanceof ApiError
      ? `${err.name}: ${err.message}`
      : err instanceof Error
        ? err.name
        : 'UnknownError'
  return text.length > ERROR_SUMMARY_MAX ? `${text.slice(0, ERROR_SUMMARY_MAX)}…` : text
}

export interface OnErrorDeps {
  /** 5xx 上报通道（可选，如 webhook adapter）；只收摘要，详见 error-report.ts */
  reporter?: ErrorReporter
}

/**
 * Hono onError 工厂：统一错误出口。
 * - 响应体：5xx 不透出内部细节
 * - 日志：凡 status≥500 必须 error 落盘（含 stack / cause / requestId），便于排障
 * - 上报：配了 reporter 时 5xx 额外发摘要（fire-and-forget，失败不影响响应）
 */
export function createOnError(deps: OnErrorDeps = {}) {
  return function onError(err: unknown, c: Context): Response {
    const { body, status } = toErrorBody(err)
    if (status >= 500) {
      logJson('error', 'http_error', {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status,
        errorCode: body.error.code,
        error: serializeError(err),
      })
      deps.reporter?.report({
        requestId: c.get('requestId') as string | undefined,
        method: c.req.method,
        path: c.req.path,
        status,
        errorCode: body.error.code,
        error: summarizeForReport(err),
        ts: new Date().toISOString(),
      })
    }
    return c.json(body, status as ContentfulStatusCode)
  }
}

/** 默认 onError（无上报通道）；生产入口用 createOnError({ reporter }) 注入 webhook */
export const onError = createOnError()

export function notFound(c: Context): Response {
  return c.json({ error: { code: 'not_found', message: '资源不存在' } } satisfies ApiErrorBody, 404)
}
