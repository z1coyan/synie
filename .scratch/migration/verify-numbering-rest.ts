import { SQL } from 'bun'

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  'postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable'

interface APIErrorEnvelope {
  error?: { code?: string; message?: string }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(baseURL + path, init)
  const text = await response.text()
  if (response.status !== expectedStatus) {
    let detail = text
    try {
      const envelope = JSON.parse(text) as APIErrorEnvelope
      detail = `${envelope.error?.code ?? 'unknown'}:${envelope.error?.message ?? text}`
    } catch {
      // 非 JSON 错误保留原始响应。
    }
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}, ${detail}`)
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const login = await request<{ token: string }>(
  '/auth/login',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  },
)
const headers = authHeaders(login.token)
const db = new SQL(databaseURL)
let ruleID: string | null = null

try {
  const [ruleMeta, counterMeta, catalog, current] = await Promise.all([
    request<{ grid: { capabilities: string[] } }>(
      '/meta/resources/sysNumberingRules',
      { headers },
    ),
    request<{ grid: { capabilities: string[]; destroyMutation?: string | null } }>(
      '/meta/resources/sysNumberingCounters',
      { headers },
    ),
    request<{ resources: { prefix: string; fields: unknown[] }[] }>(
      '/system/numbering/resources',
      { headers },
    ),
    request<{ results: { resource: string; enabled: boolean }[] }>(
      '/system/numbering/rules/query',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ limit: 200, offset: 0 }),
      },
    ),
  ])

  const capabilities = [...ruleMeta.grid.capabilities].sort().join(',')
  if (capabilities !== 'create,delete,update') {
    throw new Error(`rule capabilities=${capabilities}`)
  }
  if (
    counterMeta.grid.capabilities.length !== 0 ||
    counterMeta.grid.destroyMutation != null
  ) {
    throw new Error('counter Meta must remain read/update-only through shared permission policy')
  }
  const fieldCount = catalog.resources.reduce(
    (total, resource) => total + resource.fields.length,
    0,
  )
  if (catalog.resources.length !== 25 || fieldCount !== 695) {
    throw new Error(`numberable catalog=${catalog.resources.length}/${fieldCount}`)
  }

  const occupied = new Set(
    current.results.filter((rule) => rule.enabled).map((rule) => rule.resource),
  )
  const resource = catalog.resources.find((item) => !occupied.has(item.prefix))?.prefix
  if (!resource) throw new Error('没有可供验收的未占用编号资源')
  const suffix = crypto.randomUUID().slice(0, 8)
  const created = await request<{ id: string; name: string; segments: unknown[] }>(
    '/system/numbering/rules',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        resource,
        name: `REST验收-${suffix}`,
        segments: [
          { type: 'text', value: 'RT-' },
          { type: 'seq', padding: 3 },
        ],
        perCompany: false,
      }),
    },
    201,
  )
  ruleID = created.id
  if (created.segments.length !== 2) throw new Error('规则段未按对象数组返回')

  const updated = await request<{ name: string; enabled: boolean }>(
    `/system/numbering/rules/${ruleID}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: `REST验收已更新-${suffix}`, enabled: false }),
    },
  )
  if (updated.enabled || !updated.name.includes('已更新')) {
    throw new Error('规则更新结果错误')
  }

  const inserted = await db`
    INSERT INTO sys_numbering_counter (rule_id, scope_key, value)
    VALUES (${ruleID}::uuid, ${`REST|${suffix}`}, 7)
    RETURNING id::text AS id
  `
  const counterID = String(inserted[0].id)
  const counters = await request<{ count: number; results: { id: string }[] }>(
    '/system/numbering/counters/query',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        limit: 200,
        offset: 0,
        filter: {
          ruleId: { kind: 'fk', values: [ruleID], labels: [] },
        },
      }),
    },
  )
  if (counters.count !== 1 || counters.results[0]?.id !== counterID) {
    throw new Error('计数器规则筛选结果错误')
  }
  const counter = await request<{ value: number }>(
    `/system/numbering/counters/${counterID}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 41 }),
    },
  )
  if (counter.value !== 41) throw new Error('计数器更新结果错误')

  await request<void>(
    `/system/numbering/rules/${ruleID}`,
    { method: 'DELETE', headers },
    204,
  )
  await request<unknown>(
    `/system/numbering/counters/${counterID}`,
    { headers },
    404,
  )
  const audit = await db`
    SELECT count(*)::int AS count
    FROM sys_audit_log
    WHERE record_id = ${ruleID}::uuid
      AND resource = 'sys_numbering_rule'
  `
  if (Number(audit[0].count) !== 3) {
    throw new Error(`规则审计条数=${audit[0].count}, want 3`)
  }
  ruleID = null
  await db`
    DELETE FROM sys_audit_log
    WHERE record_id = ${created.id}::uuid
       OR record_id = ${counterID}::uuid
  `
  console.log(
    `numbering REST acceptance ok: resources=25 fields=695 rule=${created.id} counter=${counterID}`,
  )
} finally {
  if (ruleID) {
    await db`DELETE FROM sys_numbering_rule WHERE id = ${ruleID}::uuid`
    await db`DELETE FROM sys_audit_log WHERE record_id = ${ruleID}::uuid`
  }
  await db.close()
}
