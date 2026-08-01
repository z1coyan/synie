/**
 * 冒烟专用的极简 GraphQL 客户端(Node 侧,不经浏览器)。
 * 管理动线(建角色/授权/建用户/指派)与清理都用它直打后端 `/graphql`,
 * 与前端运行时同一条 HTTP 管线(带 Bearer token)。
 */

const ENDPOINT =
  process.env.E2E_GRAPHQL_URL ?? `${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}/graphql`

export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })

  if (!resp.ok) {
    throw new Error(`GraphQL HTTP ${resp.status}: ${await resp.text()}`)
  }

  const json = (await resp.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL 错误: ${json.errors.map((e) => e.message).join('; ')}`)
  }
  return json.data as T
}

/** ash_graphql 载荷 mutation(result/errors 双字段)拆封:errors 非空即抛。 */
export function unwrap<T>(payload: { result: T | null; errors: { message: string }[] | null }): T {
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`mutation 载荷错误: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  if (payload.result == null) throw new Error('mutation 无结果(result 为空)')
  return payload.result
}
