import { createApiClient, type ApiClient } from '@synie/server/client'
import type { ApiErrorBody, ApiErrorCode } from '@synie/shared'
import { getToken } from '../auth'
import { AppError } from '../errors'

/**
 * 统一 API 错误：对齐 @synie/shared 错误 envelope。
 * fields 供表单字段级错误展示。
 */
export class APIError extends AppError {
  readonly code: ApiErrorCode
  readonly fields?: Record<string, string[]>
  readonly status: number

  constructor(error: ApiErrorBody['error'], status: number) {
    super(
      error.code === 'forbidden' ? '无权限访问,请联系管理员分配权限' : error.message,
      [error.code],
    )
    this.name = 'APIError'
    this.code = error.code
    this.fields = error.fields
    this.status = status
  }
}

/**
 * hono/client 实例。baseUrl 为空串 → 相对路径 `/api/v1/...`，
 * 经 Vite 代理到 Bun server（开发）或同源反向代理（生产）。
 * token 闭包每次请求读取，登录后无需重建 client。
 */
export const apiClient: ApiClient = createApiClient('', {
  token: () => getToken(),
})

/** `/api/v1` 下的类型化路由树（契约即 ApiType） */
export const api = apiClient.api.v1

/**
 * 解析 hc 响应：2xx 返回 JSON body；错误 envelope → APIError（含 fields）。
 * 204 / 空 body 返回 undefined。
 */
export async function apiData<T = unknown>(request: Promise<Response>): Promise<T> {
  const response = await request
  if (response.ok) {
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  let envelope: ApiErrorBody | undefined
  try {
    envelope = (await response.json()) as ApiErrorBody
  } catch {
    // 非 JSON 错误体
  }
  if (envelope?.error) throw new APIError(envelope.error, response.status)
  throw new AppError(
    `API 请求失败: ${response.status} ${response.statusText}`,
    ['http_error'],
  )
}

export type { ApiClient }
