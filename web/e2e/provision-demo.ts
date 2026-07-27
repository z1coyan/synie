/**
 * Go e2e 演示库 provisioning:复刻初始化向导「示例数据」路径的 REST 调用序列
 * (对应旧 Elixir `mix synie.demo` 的语义),供 run-smoke.sh 在重建库后调用。
 *
 * 步骤:建超管 → 预置常用货币 → 启用 CNY 本位币 → 建 JT 公司 + SMALL 科目模板 →
 * 完成初始化并写全业务链示例数据 → 追加一个空科目公司(account.go.e2e 的前置)。
 *
 * 环境变量:
 *   API_BASE               默认 http://localhost:8080/api/v1
 *   E2E_ADMIN_USERNAME     默认 admin
 *   E2E_ADMIN_PASSWORD     默认 synie-integration-admin-password(与各 *.go.e2e.ts 一致)
 */

const apiBase = process.env.API_BASE ?? 'http://localhost:8080/api/v1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as T
}

interface LoginResponse {
  token: string
}

interface QueryResult<R> {
  count: number
  results: R[]
}

// 1. 首个超管(返回登录态,免二次登录)
const firstUser = await call<LoginResponse>('POST', '/setup/first-user', {
  username,
  name: '系统管理员',
  password,
})
const token = firstUser.token
console.log('[provision] 超管已创建')

// 2. 预置常用货币(幂等)
await call('POST', '/setup/currencies/seed-common', {}, token)

// 3. 启用 CNY 为本位币(建公司前置:公司本币校验要求启用中的货币)
const currencies = await call<QueryResult<{ id: string; isoCode: string }>>(
  'POST',
  '/base/currencies/query',
  { limit: 200, offset: 0 },
  token,
)
const cny = currencies.results.find((row) => row.isoCode === 'CNY')
if (!cny) throw new Error('预置货币中未找到 CNY')
await call('POST', '/setup/currencies/activate-base', { currencyId: cny.id }, token)
console.log('[provision] CNY 本位币已启用')

// 4. 演示公司 JT(与 mix synie.demo 一致),同事务初始化 3 个默认仓库
const jt = await call<{ id: string }>('POST', '/base/companies', {
  code: 'JT',
  name: '台州京泰电气有限公司',
  shortName: '台州京泰',
  baseCurrencyId: cny.id,
}, token)

// 5. 按 SMALL 模板初始化 JT 科目表
const init = await call<{ createdCount: number }>(
  'POST',
  '/base/accounts/init-template',
  { companyId: jt.id, template: 'SMALL' },
  token,
)
console.log(`[provision] JT 公司已创建,初始化 ${init.createdCount} 个科目`)

// 6. 完成初始化并写入全业务链示例数据(挂在首个公司 JT 上)
await call('POST', '/setup/complete', {
  preferredLanguage: 'zh-CN',
  seedSampleData: true,
}, token)
console.log('[provision] 初始化完成,示例业务数据已写入')

// 7. 追加空科目公司:account.go.e2e 需要一家 0 科目的公司跑科目模板动线
//    (历史上由既有 dev 库里其他 spec 的残留公司提供,一键重建时必须显式补)
await call('POST', '/base/companies', {
  code: 'EK',
  name: 'E2E 空科目公司',
  shortName: 'E2E 空公司',
  baseCurrencyId: cny.id,
}, token)
console.log('[provision] 空科目公司已追加')

// 8. files.go.e2e 的基线存储(历史 dev 库手工预置,一键重建时显式补)
await call('POST', '/system/storages', {
  name: 'go-e2e-local',
  label: 'go-e2e-local',
  kind: 'LOCAL',
  root: 'uploads',
}, token)
console.log('[provision] go-e2e-local 存储已创建')
