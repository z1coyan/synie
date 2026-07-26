import createClient from 'openapi-fetch'
import { getToken } from '../auth'
import { AppError } from '../errors'
import type { components, paths } from './schema'

type ErrorEnvelope = components['schemas']['ErrorEnvelope']

export class APIError extends AppError {
  readonly code: components['schemas']['APIError']['code']
  readonly fields?: Record<string, string[]>
  readonly status: number

  constructor(error: components['schemas']['APIError'], status: number) {
    super(error.code === 'forbidden' ? '无权限访问,请联系管理员分配权限' : error.message, [error.code])
    this.name = 'APIError'
    this.code = error.code
    this.fields = error.fields
    this.status = status
  }
}

export const apiClient = createClient<paths>({ baseUrl: '/api/v1' })

apiClient.use({
  onRequest({ request }) {
    const token = getToken()
    if (token) request.headers.set('Authorization', `Bearer ${token}`)
    return request
  },
})

interface APIResult<T> {
  data?: T
  error?: unknown
  response: Response
}

export async function apiData<T>(request: Promise<APIResult<T>>): Promise<T> {
  const result = await request
  if (result.response.ok) return result.data as T

  const envelope = result.error as ErrorEnvelope | undefined
  if (envelope?.error) throw new APIError(envelope.error, result.response.status)
  throw new AppError(`API 请求失败: ${result.response.status} ${result.response.statusText}`, ['http_error'])
}
