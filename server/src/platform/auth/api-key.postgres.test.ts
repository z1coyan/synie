/**
 * 个人 API 密钥：自助签发、三轨认证、密钥不能管密钥。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { syncUserCredential } from '~/platform/auth/credentials.ts'
import { hashPassword } from '~/platform/auth/password.ts'
import { API_KEY_PREFIX } from '~/platform/auth/api-key.ts'
import { buildTestApp, testDatabaseUrl } from '../../../test/helpers.ts'

const databaseUrl = testDatabaseUrl()
const describePg = databaseUrl ? describe : describe.skip

type ErrorBody = { error: { code: string; message: string } }

describePg('个人 API 密钥（PG 集成）', () => {
  let db: Kysely<Database>
  let app: Awaited<ReturnType<typeof buildTestApp>>
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  const username = `akey${suffix}`
  const password = 'api-key-pass-123'
  const otherUsername = `akeyb${suffix}`
  const otherPassword = 'api-key-pass-456'
  const userIds: string[] = []

  async function insertUser(name: string, pass: string) {
    const id = crypto.randomUUID()
    userIds.push(id)
    const hashed = await hashPassword(pass)
    await withTx(db, async (trx) => {
      await trx
        .insertInto('sys_user')
        .values({ id, username: name, name, hashed_password: hashed, super_admin: false })
        .execute()
      await syncUserCredential(trx, { userId: id, hashedPassword: hashed })
    })
    return id
  }

  async function loginJwt(name: string, pass: string) {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: pass }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string }
    return { authorization: `Bearer ${body.token}` }
  }

  async function signInCookie(name: string, pass: string) {
    const res = await app.request('/api/v1/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: pass }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    expect(cookie).toContain('synie.session_token=')
    return { cookie }
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!)
    app = await buildTestApp(db)
    await insertUser(username, password)
    await insertUser(otherUsername, otherPassword)
  })

  afterAll(async () => {
    const authUserIds = (
      await db.selectFrom('sys_user').select('auth_user_id').where('id', 'in', userIds).execute()
    )
      .map((r) => r.auth_user_id)
      .filter((v): v is string => Boolean(v))
    await db.deleteFrom('sys_user').where('id', 'in', userIds).execute()
    if (authUserIds.length > 0) {
      await db.deleteFrom('auth_user').where('id', 'in', authUserIds).execute()
    }
    await db.destroy()
  })

  test('创建返回明文一次，列表不再含 token；JWT 可管理', async () => {
    const headers = await loginJwt(username, password)
    const created = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grok' }),
    })
    expect(created.status).toBe(201)
    const key = (await created.json()) as {
      id: string
      name: string
      token: string
      tokenHint: string
    }
    expect(key.name).toBe('Grok')
    expect(key.token.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(key.tokenHint.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(key.token.length).toBeGreaterThan(key.tokenHint.length)

    const listed = await app.request('/api/v1/auth/api-keys', { headers })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { results: Array<Record<string, unknown>> }
    const mine = body.results.find((row) => row.id === key.id)
    expect(mine).toBeDefined()
    expect(mine).not.toHaveProperty('token')
    expect(mine?.tokenHint).toBe(key.tokenHint)

    await app.request(`/api/v1/auth/api-keys/${key.id}`, { method: 'DELETE', headers })
  })

  test('个人密钥可调 /me，且不能管理密钥', async () => {
    const headers = await loginJwt(username, password)
    const created = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Cursor' }),
    })
    const key = (await created.json()) as { id: string; token: string }
    const pat = { authorization: `Bearer ${key.token}` }

    const me = await app.request('/api/v1/auth/me', { headers: pat })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { user: { username: string } }
    expect(meBody.user.username).toBe(username)

    const denied: Array<[string, RequestInit]> = [
      ['GET', { headers: pat }],
      [
        'POST',
        {
          headers: { ...pat, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'spawn' }),
        },
      ],
      ['DELETE', { headers: pat }],
    ]
    for (const [method, init] of denied) {
      const path = method === 'DELETE' ? `/api/v1/auth/api-keys/${key.id}` : '/api/v1/auth/api-keys'
      const res = await app.request(path, { method, ...init })
      expect(res.status).toBe(401)
      const err = (await res.json()) as ErrorBody
      expect(err.error.message).toBe('个人 API 密钥不能管理密钥')
    }

    await app.request(`/api/v1/auth/api-keys/${key.id}`, { method: 'DELETE', headers })
  })

  test('cookie 会话可创建并撤销', async () => {
    const { cookie } = await signInCookie(username, password)
    const created = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '本机会话' }),
    })
    expect(created.status).toBe(201)
    const key = (await created.json()) as { id: string }
    const revoked = await app.request(`/api/v1/auth/api-keys/${key.id}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(revoked.status).toBe(204)
  })

  test('撤销或过期后 401，且 synie_ak_ 前缀不回落 JWT', async () => {
    const headers = await loginJwt(username, password)
    const created = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '临时' }),
    })
    const key = (await created.json()) as { id: string; token: string }

    await app.request(`/api/v1/auth/api-keys/${key.id}`, { method: 'DELETE', headers })
    const afterRevoke = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${key.token}` },
    })
    expect(afterRevoke.status).toBe(401)

    const garbage = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${API_KEY_PREFIX}not-a-real-key` },
    })
    expect(garbage.status).toBe(401)

    const future = new Date(Date.now() + 60_000).toISOString()
    const expiring = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '将过期', expiresAt: future }),
    })
    const expKey = (await expiring.json()) as { id: string; token: string }
    await db
      .updateTable('sys_user_api_key')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', expKey.id)
      .execute()
    const expired = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${expKey.token}` },
    })
    expect(expired.status).toBe(401)
    await app.request(`/api/v1/auth/api-keys/${expKey.id}`, { method: 'DELETE', headers })
  })

  test('不能撤销他人密钥；第 11 把 conflict；审计无明文无 hash', async () => {
    const a = await loginJwt(username, password)
    const b = await loginJwt(otherUsername, otherPassword)
    const created = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { ...a, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice专用' }),
    })
    const key = (await created.json()) as { id: string; token: string }

    const stolen = await app.request(`/api/v1/auth/api-keys/${key.id}`, {
      method: 'DELETE',
      headers: b,
    })
    expect(stolen.status).toBe(404)
    const stolenBody = (await stolen.json()) as ErrorBody
    expect(stolenBody.error.code).toBe('not_found')

    const extras: string[] = []
    for (let i = 0; i < 9; i++) {
      const res = await app.request('/api/v1/auth/api-keys', {
        method: 'POST',
        headers: { ...a, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `批量${i}` }),
      })
      expect(res.status).toBe(201)
      extras.push(((await res.json()) as { id: string }).id)
    }
    const eleventh = await app.request('/api/v1/auth/api-keys', {
      method: 'POST',
      headers: { ...a, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '超限' }),
    })
    expect(eleventh.status).toBe(409)
    const eleventhBody = (await eleventh.json()) as ErrorBody
    expect(eleventhBody.error.code).toBe('conflict')

    const audits = await db
      .selectFrom('sys_audit_log')
      .select(['changes', 'record_label'])
      .where('resource', '=', 'sysUserApiKeys')
      .where('record_id', '=', key.id)
      .execute()
    expect(audits.length).toBeGreaterThan(0)
    const blob = JSON.stringify(audits)
    expect(blob).not.toContain(key.token)
    expect(blob).not.toContain('token_hash')
    expect(audits.some((row) => row.record_label === 'Alice专用')).toBe(true)

    for (const id of [key.id, ...extras]) {
      await app.request(`/api/v1/auth/api-keys/${id}`, { method: 'DELETE', headers: a })
    }
  })
})
