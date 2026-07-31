import { createApiClient, type ApiClient } from '@synie/server/client'
import type { ApiErrorBody, ApiErrorCode } from '@synie/shared'
import type {
  ClientResponse,
  InferResponseType,
} from 'hono/client'
import type { ResponseFormat } from 'hono/types'
import type {
  StatusCode,
  SuccessStatusCode,
} from 'hono/utils/http-status'
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
 * Hono endpoint 的成功 body。错误 status 在类型层被排除，不会污染资源 module
 * 对 production endpoint 的返回类型推断。
 */
export type ApiSuccess<TEndpoint> = InferResponseType<
  TEndpoint,
  SuccessStatusCode
>

type HonoResponse = ClientResponse<
  unknown,
  StatusCode,
  ResponseFormat
>

/**
 * 已经发出的 Hono 请求所对应的成功 body。
 * ClientResponse 是联合类型时按 status 分发；204 映射为运行时实际返回的 undefined。
 */
export type ApiResponseData<TResponse> =
  TResponse extends ClientResponse<
    infer TBody,
    infer TStatus,
    ResponseFormat
  >
    ? TStatus extends SuccessStatusCode
      ? TStatus extends 204
        ? undefined
        : TBody
      : never
    : never

/**
 * response 解析的最小 interface。production Hono ClientResponse 与测试 fake
 * 都通过本 seam；测试无需伪造完整浏览器 Response。
 */
export interface ApiResponseAdapter {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: Pick<Headers, 'get'>
  text(): Promise<string>
}

function parsedBody(text: string, contentType: string | null): unknown {
  if (contentType?.toLowerCase().includes('json')) {
    // 服务端已经声明 JSON 时，解析失败就是 transport 契约错误，不能把 string
    // 伪装成 Hono 静态类型所承诺的对象继续向下传递。
    return JSON.parse(text) as unknown
  }
  if (contentType == null) {
    if (!text) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      // 无 content-type 的纯文本响应仍保留为 string。
    }
  }
  return text
}

function errorEnvelope(body: unknown): ApiErrorBody | undefined {
  if (typeof body !== 'object' || body == null || !('error' in body)) {
    return undefined
  }
  const error = body.error
  if (
    typeof error !== 'object' ||
    error == null ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !('message' in error) ||
    typeof error.message !== 'string'
  ) {
    return undefined
  }
  return body as ApiErrorBody
}

/**
 * 解析一个 response Adapter：2xx 返回 body；项目错误 envelope → APIError（含 fields）。
 * 204 返回 undefined。非 JSON 成功响应保留为 string。
 */
export async function readApiResponse(
  response: ApiResponseAdapter,
): Promise<unknown> {
  if (response.ok) {
    if (response.status === 204) return undefined
    const text = await response.text()
    return parsedBody(text, response.headers.get('content-type'))
  }

  let body: unknown
  try {
    body = parsedBody(
      await response.text(),
      response.headers.get('content-type'),
    )
  } catch {
    // 非 JSON 错误体
  }
  const envelope = errorEnvelope(body)
  if (envelope?.error) throw new APIError(envelope.error, response.status)
  throw new AppError(
    `API 请求失败: ${response.status} ${response.statusText}`,
    ['http_error'],
  )
}

/**
 * 解析 hc 响应，同时保留 Hono ClientResponse 的成功 body 类型。
 */
export function apiData<TResponse extends HonoResponse>(
  request: Promise<TResponse>,
): Promise<ApiResponseData<TResponse>>
export async function apiData(
  request: Promise<ApiResponseAdapter>,
): Promise<unknown> {
  return readApiResponse(await request)
}

export type { ApiClient }
