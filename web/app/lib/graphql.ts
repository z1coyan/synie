import { getToken } from './auth'

/** GraphQL 业务错误;codes 保留后端错误码(如 forbidden)供 UI 分支处理 */
export class GqlError extends Error {
  codes: string[]

  constructor(message: string, codes: string[]) {
    super(message)
    this.codes = codes
  }
}

export const isForbidden = (e: unknown): boolean => e instanceof GqlError && e.codes.includes('forbidden')

export async function gqlFetch<TData = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<TData> {
  const token = getToken()

  const res = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`)
  }

  const json = await res.json() as { data?: TData; errors?: Array<{ message: string; code?: string }> }

  if (json.errors && json.errors.length > 0) {
    // 后端裸 "forbidden" 对用户无信息量,统一翻译;其余透传
    const message = json.errors
      .map((e) => (e.code === 'forbidden' ? '无权限访问,请联系管理员分配权限' : e.message))
      .join('; ')
    throw new GqlError(message, json.errors.flatMap((e) => (e.code ? [e.code] : [])))
  }

  if (!json.data) {
    throw new Error('GraphQL response had no data')
  }

  return json.data
}