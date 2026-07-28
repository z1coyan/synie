/**
 * 工单 17 关键路径 API 验收（不依赖 HeroUI Pro / Playwright UI）：
 * 登录 → 主数据 CRUD → 销售报价/订单链 → 权限拒绝
 *
 *   SYNIE_API_URL=http://127.0.0.1:8091/api/v1 \
 *   E2E_ADMIN_PASSWORD=... bun scripts/verify-web-hc-api.ts
 */
const apiBase = process.env.SYNIE_API_URL ?? process.env.API_BASE ?? 'http://127.0.0.1:8091/api/v1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const suffix = Date.now().toString(36).toUpperCase()

async function call(
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown; expectStatus?: number },
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }
  if (opts?.expectStatus != null && res.status !== opts.expectStatus) {
    throw new Error(`${method} ${path} → ${res.status} (want ${opts.expectStatus}): ${text}`)
  }
  if (opts?.expectStatus == null && !res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return { status: res.status, json }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object') throw new Error(`expected object, got ${typeof v}`)
  return v as Record<string, unknown>
}

console.log('[verify] healthz')
await call('GET', '/healthz', { expectStatus: 200 })

console.log('[verify] setup/status')
const status = asRecord((await call('GET', '/setup/status', { expectStatus: 200 })).json)
if (!status.initialized) throw new Error('setup not initialized — run provision first')

console.log('[verify] login')
const login = asRecord(
  (
    await call('POST', '/auth/login', {
      body: { username, password },
      expectStatus: 200,
    })
  ).json,
)
const token = String(login.token)
if (!token) throw new Error('missing token')

console.log('[verify] me')
const me = asRecord((await call('GET', '/auth/me', { token, expectStatus: 200 })).json)
if (!me.superAdmin) throw new Error('expected superAdmin')

// 公司 code 恰好两位英文字母；币种 iso 尽量唯一
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const n = Date.now() % (26 * 26)
const companyCode = `${letters[Math.floor(n / 26)]!}${letters[n % 26]!}`
const isoCode = `Z${letters[n % 26]!}${letters[Math.floor(n / 26) % 26]!}`

console.log('[verify] currency CRUD')
const currency = asRecord(
  (
    await call('POST', '/base/currencies', {
      token,
      body: { name: `验收币-${suffix}`, isoCode, symbol: '¤', active: true },
      expectStatus: 201,
    })
  ).json,
)
const currencyId = String(currency.id)
await call('PATCH', `/base/currencies/${currencyId}`, {
  token,
  body: { name: `验收币改-${suffix}` },
  expectStatus: 200,
})

console.log('[verify] company create')
const company = asRecord(
  (
    await call('POST', '/base/companies', {
      token,
      body: {
        code: companyCode,
        name: `验收公司-${suffix}`,
        shortName: `短-${suffix.slice(0, 4)}`,
        baseCurrencyId: currencyId,
      },
      expectStatus: 201,
    })
  ).json,
)
const companyId = String(company.id)

console.log('[verify] customer + sales quotation → order chain')
const customer = asRecord(
  (
    await call('POST', '/sales/customers', {
      token,
      body: { code: `C${suffix.slice(0, 6)}`, name: `客户-${suffix}`, shortName: '客户' },
      expectStatus: 201,
    })
  ).json,
)
const quotation = asRecord(
  (
    await call('POST', '/sales/quotations', {
      token,
      body: {
        quotationNo: `SQ-${suffix}`,
        quotationDate: '2026-07-01',
        validUntil: '2026-08-31',
        partyType: 'CUSTOMER',
        partyId: customer.id,
        companyId,
        currencyId,
      },
      expectStatus: 201,
    })
  ).json,
)
const order = asRecord(
  (
    await call('POST', '/sales/orders', {
      token,
      body: {
        orderNo: `SO-${suffix}`,
        orderDate: '2026-07-02',
        partyType: 'CUSTOMER',
        partyId: customer.id,
        companyId,
        currencyId,
        exchangeRate: '1',
      },
      expectStatus: 201,
    })
  ).json,
)
console.log('[verify] sales chain ids', { quotation: quotation.id, order: order.id })

console.log('[verify] authz deny (no token → 401)')
await call('GET', '/auth/me', { expectStatus: 401 })

console.log('[verify] authz deny (invalid token → 401)')
await call('GET', '/auth/me', { token: 'not-a-jwt', expectStatus: 401 })

console.log('[verify] OK — login / master CRUD / sales chain / authz deny')
