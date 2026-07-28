/**
 * 工单 16 验收：setup 向导 / 示例数据冒烟。
 *
 * 用法：
 *   # 对已初始化+示例数据的活服务（demo 冒烟）
 *   SYNIE_API_URL=http://127.0.0.1:8080/api/v1 bun .scratch/migration/verify-setup-rest.ts
 *
 *   # 空库端到端（需 SYNIE_SETUP_E2E=1；服务指向可破坏的库）
 *   SYNIE_SETUP_E2E=1 SYNIE_API_URL=... bun .scratch/migration/verify-setup-rest.ts
 *
 * env：
 *   SYNIE_API_URL / GO_API_URL — API 根（默认 http://127.0.0.1:8080/api/v1）
 *   E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD — 已初始化时的登录账号
 *   SYNIE_SETUP_E2E — 设为 1 时走空库 first-user → complete(含示例) 全路径
 */
const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const setupE2E = process.env.SYNIE_SETUP_E2E === '1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin123'

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
      // keep raw
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

async function queryCount(token: string, path: string): Promise<number> {
  const body = await request<{ count: number }>(path, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ limit: 10 }),
  })
  return body.count
}

async function demoSmoke(token: string): Promise<void> {
  const customers = await request<{ count: number; results: Array<{ code: string }> }>(
    '/sales/customers/query',
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        limit: 50,
        filter: { code: { kind: 'text', op: 'eq', value: 'C01' } },
      }),
    },
  )
  if (customers.count < 1 || !customers.results.some((r) => r.code === 'C01')) {
    throw new Error('示例数据冒烟失败: 未找到客户 C01')
  }

  const checks: Array<[string, number]> = [
    ['/purchase/suppliers/query', 1],
    ['/sales/orders/query', 1],
    ['/purchase/orders/query', 1],
    ['/sales/quotations/query', 1],
    ['/purchase/quotations/query', 1],
    ['/sales/deliveries/query', 1],
    ['/purchase/receipts/query', 1],
    ['/inventory/stock-docs/query', 1],
    ['/accounting/gl-journals/query', 1],
    ['/finance/bank-accounts/query', 1],
  ]

  for (const [path, min] of checks) {
    const count = await queryCount(token, path)
    if (count < min) {
      throw new Error(`示例数据冒烟失败: ${path} count=${count} < ${min}`)
    }
    console.log(`  ok ${path} count=${count}`)
  }
  console.log('demo 数据冒烟通过（C01 + 销采/库存/凭证/银行列表）')
}

async function emptySetupE2E(): Promise<string> {
  const status = await request<{ initialized: boolean; hasUsers: boolean }>('/setup/status')
  if (status.initialized || status.hasUsers) {
    throw new Error(
      `SYNIE_SETUP_E2E=1 要求空库（initialized=${status.initialized} hasUsers=${status.hasUsers}）`,
    )
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const userA = `setup_e2e_${suffix}`
  const first = await request<{ token: string; user: { id: string; username: string } }>(
    '/setup/first-user',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: userA, name: 'E2E管理员', password: 'admin123' }),
    },
    201,
  )
  if (!first.token) throw new Error('first-user 未返回 token')

  // 并发 second user 应 conflict
  const conflict = await fetch(baseURL + '/setup/first-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `other_${suffix}`, password: 'admin123' }),
  })
  if (conflict.status !== 409) {
    throw new Error(`并发 first-user 期望 409，得到 ${conflict.status}`)
  }

  const headers = authHeaders(first.token)
  const seeded = await request<{ created: number }>('/setup/currencies/seed-common', {
    method: 'POST',
    headers,
  })
  console.log(`  currencies created=${seeded.created}`)

  // 需要公司才能跑示例：通过 base API 建公司前先激活本币
  // 取 CNY id
  const currencies = await request<{ count: number; results: Array<{ id: string; isoCode: string }> }>(
    '/base/currencies/query',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        limit: 50,
        filter: { isoCode: { kind: 'text', op: 'eq', value: 'CNY' } },
      }),
    },
  )
  const cny = currencies.results.find((c) => c.isoCode === 'CNY')
  if (!cny) throw new Error('未找到 CNY')
  await request('/setup/currencies/activate-base', {
    method: 'POST',
    headers,
    body: JSON.stringify({ currencyId: cny.id }),
  })

  await request(
    '/base/companies',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'JT',
        name: '台州京泰电气有限公司',
        shortName: '台州京泰',
        baseCurrencyId: cny.id,
      }),
    },
    201,
  )

  // 科目表模板
  const companies = await request<{ results: Array<{ id: string }> }>('/base/companies/query', {
    method: 'POST',
    headers,
    body: JSON.stringify({ limit: 5 }),
  })
  const companyId = companies.results[0]?.id
  if (!companyId) throw new Error('公司创建后未找到')
  await request(`/base/accounts/init-template`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ companyId, template: 'small' }),
  })

  await request('/setup/complete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ preferredLanguage: 'zh-CN', seedSampleData: true }),
  })

  const after = await request<{ initialized: boolean }>('/setup/status')
  if (!after.initialized) throw new Error('complete 后 initialized 应为 true')

  // 再 complete 应 conflict
  const again = await fetch(baseURL + '/setup/complete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ preferredLanguage: 'zh-CN', seedSampleData: true }),
  })
  if (again.status !== 409) {
    throw new Error(`重复 complete 期望 409，得到 ${again.status}`)
  }

  console.log('空库 setup e2e 通过')
  return first.token
}

const status = await request<{ initialized: boolean; hasUsers: boolean }>('/setup/status')
console.log(`setup/status initialized=${status.initialized} hasUsers=${status.hasUsers}`)

let token: string
if (setupE2E) {
  token = await emptySetupE2E()
} else if (!status.initialized) {
  console.log('系统未初始化；跳过 demo 冒烟（设 SYNIE_SETUP_E2E=1 跑空库全路径）')
  process.exit(0)
} else {
  const login = await request<{ token: string }>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  token = login.token
}

await demoSmoke(token)
console.log('verify-setup-rest 全绿')
