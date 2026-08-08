/**
 * CI smoke 最小 provisioning：复刻初始化向导的最短路径（不写示例数据），
 * 供 ci.yml 的 smoke job 在「迁移后、跑 verify-web-hc-api.ts 前」调用。
 *
 * 步骤：建超管（/setup/first-user，返回登录态）→ 完成初始化（/setup/complete）。
 * 与 web/e2e/provision-demo.ts 的区别：不建 JT 公司、不初始化科目模板、不写示例数据，
 * verify 脚本自建币种/公司/客户，跑完即弃库。
 *
 * 环境变量（与 verify-web-hc-api.ts 同口径）：
 *   SYNIE_API_URL / API_BASE   默认 http://127.0.0.1:8080/api/v1
 *   E2E_ADMIN_USERNAME         默认 admin
 *   E2E_ADMIN_PASSWORD         默认 admin123
 *   VERIFY_REQUEST_TIMEOUT_MS  单次请求超时，默认 10000
 */

const apiBase = process.env.SYNIE_API_URL ?? process.env.API_BASE ?? 'http://127.0.0.1:8080/api/v1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin123'
const requestTimeoutMs = Number(process.env.VERIFY_REQUEST_TIMEOUT_MS ?? 10_000)

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return (text ? JSON.parse(text) : null) as T
}

// 0. 前置：库已迁移、尚未初始化（重复执行直接报错，CI 每次都是新库）
const status = await call<{ initialized: boolean }>('GET', '/setup/status')
if (status.initialized) {
  throw new Error('系统已完成初始化，smoke provisioning 只适用于全新库')
}

// 1. 首个超管（返回登录态，免二次登录）
const firstUser = await call<{ token: string }>('POST', '/setup/first-user', {
  username,
  name: '系统管理员',
  password,
})
console.log('[provision] 超管已创建')

// 2. 完成初始化（不写示例数据；基础种子：本地存储/编号规则/计量单位/内置角色）
await call('POST', '/setup/complete', { preferredLanguage: 'zh-CN', seedSampleData: false }, firstUser.token)
console.log('[provision] 初始化完成（未写入示例数据）')
