import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { ensureAdmin } from '../db/seed-admin.ts'
import { buildTestApp, testDatabaseUrl } from './helpers.ts'

/**
 * PG 集成测试：门控 SYNIE_TEST_DATABASE_URL（未设置则整组 Skip，同 server-go 惯例）。
 * 前置：测试库已执行 bun run db:migrate。
 */
const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('PG 集成（auth + meta + healthz）', () => {
  const db = createDb(url!)
  const adminPassword = 'integration-admin-pass'

  async function app() {
    await ensureAdmin(db, { username: 'it-admin', password: adminPassword, name: '集成管理员' })
    return buildTestApp(db)
  }

  afterAll(async () => {
    await db.destroy()
  })

  test('healthz 200', async () => {
    const res = await (await app()).request('/api/v1/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('登录成功 → /me 返回 Actor；错误密码 401 且形状统一', async () => {
    const server = await app()

    const bad = await server.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'it-admin', password: 'wrong' }),
    })
    expect(bad.status).toBe(401)
    expect(await bad.json()).toEqual({ error: { code: 'unauthorized', message: '用户名或密码错误' } })

    const ok = await server.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'it-admin', password: adminPassword }),
    })
    expect(ok.status).toBe(200)
    const login = (await ok.json()) as { token: string; user: { username: string } }
    expect(login.token.length).toBeGreaterThan(0)
    expect(login.user.username).toBe('it-admin')

    const me = await server.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${login.token}` },
    })
    expect(me.status).toBe(200)
    const actor = (await me.json()) as { superAdmin: boolean; permissions: string[] }
    expect(actor.superAdmin).toBe(true)

    const anonymous = await server.request('/api/v1/auth/me')
    expect(anonymous.status).toBe(401)
  })

  test('入参形状错误 → 400 validation 带 fields', async () => {
    const res = await (await app()).request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'only-name' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; fields?: Record<string, string[]> } }
    expect(body.error.code).toBe('validation')
    expect(body.error.fields).toHaveProperty('password')
  })

  test('meta 端点（骨架期空注册表）', async () => {
    const server = await app()
    const login = await server.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'it-admin', password: adminPassword }),
    })
    const { token } = (await login.json()) as { token: string }
    const headers = { authorization: `Bearer ${token}` }

    const resources = await server.request('/api/v1/meta/resources', { headers })
    expect(resources.status).toBe(200)
    expect(await resources.json()).toEqual({ resources: [] })

    const catalog = await server.request('/api/v1/meta/permission-catalog', { headers })
    expect(await catalog.json()).toEqual({ groups: [] })

    const missing = await server.request('/api/v1/meta/resources/unknown', { headers })
    expect(missing.status).toBe(404)

    const anonymous = await server.request('/api/v1/meta/resources')
    expect(anonymous.status).toBe(401)
  })

  test('未知路径 404 形状统一', async () => {
    const res = await (await app()).request('/api/v1/nope')
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: { code: string; message: string } }).toEqual({
      error: { code: 'not_found', message: '资源不存在' },
    })
  })
})
