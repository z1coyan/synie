import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { createOAuthProvision } from '~/platform/auth/better-auth.ts'
import { syncUserCredential } from '~/platform/auth/credentials.ts'
import { hashPassword } from '~/platform/auth/password.ts'
import { buildTestApp, testDatabaseUrl } from './helpers.ts'

const databaseUrl = testDatabaseUrl()
const describePg = databaseUrl ? describe : describe.skip

/** 从迁移 00016 提取回填段（backfill:begin/end 标记），对拍「存量用户可走新通道」 */
async function runBackfill(db: Kysely<Database>): Promise<void> {
  const content = await Bun.file(
    new URL('../db/migrations/00016_better_auth.sql', import.meta.url),
  ).text()
  const begin = content.indexOf('-- backfill:begin')
  const end = content.indexOf('-- backfill:end')
  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  const section = content.slice(begin, end)
  for (const stmt of section.split(';')) {
    const trimmed = stmt.trim()
    if (!trimmed || trimmed.split('\n').every((line) => line.trim().startsWith('--'))) continue
    await sql.raw(trimmed).execute(db)
  }
}

describePg('better-auth cookie 会话双轨（PG 集成）', () => {
  let db: Kysely<Database>
  let app: Awaited<ReturnType<typeof buildTestApp>>
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  // 存量用户：只插 sys_user（旧形态，无 auth_* 行），密码走迁移回填
  const legacyUsername = `Legacy${suffix}`
  const legacyPassword = 'legacy-pass-123'
  // 新建用户：走 credentials helper（IAM/setup 收口路径）
  const freshUsername = `fresh${suffix}`
  const freshPassword = 'fresh-pass-123'
  const sysUserIds: string[] = []

  async function signInCookie(username: string, password: string, expected = 200) {
    const res = await app.request('/api/v1/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    expect(res.status).toBe(expected)
    const setCookies = res.headers.getSetCookie()
    if (expected !== 200) return { cookie: '' }
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    expect(cookie).toContain('synie.session_token=')
    return { cookie }
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!)
    app = await buildTestApp(db)

    const legacyId = crypto.randomUUID()
    sysUserIds.push(legacyId)
    await db
      .insertInto('sys_user')
      .values({
        id: legacyId,
        username: legacyUsername,
        name: '存量用户',
        hashed_password: await hashPassword(legacyPassword),
        super_admin: true,
        all_companies: true,
      })
      .execute()
    // 模拟迁移回填（幂等段；对真实迁移 SQL 对拍）
    await runBackfill(db)

    const freshId = crypto.randomUUID()
    sysUserIds.push(freshId)
    const freshHashed = await hashPassword(freshPassword)
    await withTx(db, async (trx) => {
      await trx
        .insertInto('sys_user')
        .values({
          id: freshId,
          username: freshUsername,
          name: '新建用户',
          hashed_password: freshHashed,
          super_admin: false,
          all_companies: false,
        })
        .execute()
      await syncUserCredential(trx, { userId: freshId, hashedPassword: freshHashed })
    })
  })

  afterAll(async () => {
    const authUserIds = (
      await db
        .selectFrom('sys_user')
        .select('auth_user_id')
        .where('id', 'in', sysUserIds)
        .execute()
    )
      .map((r) => r.auth_user_id)
      .filter((v): v is string => Boolean(v))
    await db.deleteFrom('sys_user').where('id', 'in', sysUserIds).execute()
    if (authUserIds.length > 0) {
      await db.deleteFrom('auth_user').where('id', 'in', authUserIds).execute()
    }
    await db.destroy()
  })

  test('回填存量用户：旧密码走 sign-in/username 拿 cookie，/auth/me 出正确 Actor', async () => {
    const legacy = await db
      .selectFrom('sys_user')
      .select(['id', 'auth_user_id'])
      .where('id', '=', sysUserIds[0]!)
      .executeTakeFirstOrThrow()
    expect(legacy.auth_user_id).toBeTruthy()

    const { cookie } = await signInCookie(legacyUsername, legacyPassword)
    const me = await app.request('/api/v1/auth/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as {
      user: { id: string; username: string }
      superAdmin: boolean
    }
    // actor 必须是 sys_user（而非 auth_user）身份
    expect(body.user.id).toBe(legacy.id)
    expect(body.user.username.toLowerCase()).toBe(legacyUsername.toLowerCase())
    expect(body.superAdmin).toBe(true)
  })

  test('回填存量用户：旧 Bearer 通道原契约不变', async () => {
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: legacyUsername, password: legacyPassword }),
    })
    expect(login.status).toBe(200)
    const { token, expiresAt } = (await login.json()) as { token: string; expiresAt: string }
    expect(token).toBeTruthy()
    expect(expiresAt).toBeTruthy()

    const me = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(me.status).toBe(200)
  })

  test('双轨回退：cookie 无效但 Bearer 有效仍放行；双失败 401', async () => {
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: freshUsername, password: freshPassword }),
    })
    expect(login.status).toBe(200)
    const { token } = (await login.json()) as { token: string }

    const fallback = await app.request('/api/v1/auth/me', {
      headers: {
        cookie: 'synie.session_token=garbage.invalid',
        authorization: `Bearer ${token}`,
      },
    })
    expect(fallback.status).toBe(200)

    const failing: Record<string, string>[] = [
      {},
      { cookie: 'synie.session_token=garbage.invalid' },
      { authorization: 'Bearer not-a-jwt' },
      { cookie: 'synie.session_token=garbage.invalid', authorization: 'Bearer not-a-jwt' },
    ]
    for (const headers of failing) {
      const res = await app.request('/api/v1/auth/me', { headers })
      expect(res.status).toBe(401)
    }
  })

  test('credentials helper：新建用户可走新通道；改密后旧密码失效', async () => {
    const { cookie } = await signInCookie(freshUsername, freshPassword)
    const me = await app.request('/api/v1/auth/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { id: string }; superAdmin: boolean }
    expect(body.user.id).toBe(sysUserIds[1]!)
    expect(body.superAdmin).toBe(false)

    // 改密（reset 路径同 helper）：sys_user 与 auth_account 双写不漂移
    const nextPassword = 'fresh-pass-456'
    const nextHashed = await hashPassword(nextPassword)
    await withTx(db, async (trx) => {
      await syncUserCredential(trx, { userId: sysUserIds[1]!, hashedPassword: nextHashed })
    })
    await signInCookie(freshUsername, freshPassword, 401)
    await signInCookie(freshUsername, nextPassword, 200)
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: freshUsername, password: nextPassword }),
    })
    expect(login.status).toBe(200)
  })

  test('credentials helper：同名孤儿 auth_user 被收养重置（sys_user 直删后重建不撞唯一索引）', async () => {
    const username = `orphan${suffix}`
    const firstId = crypto.randomUUID()
    const firstHashed = await hashPassword('orphan-pass-1')
    await withTx(db, async (trx) => {
      await trx
        .insertInto('sys_user')
        .values({ id: firstId, username, hashed_password: firstHashed })
        .execute()
      await syncUserCredential(trx, { userId: firstId, hashedPassword: firstHashed })
    })
    const firstAuthId = (
      await db
        .selectFrom('sys_user')
        .select('auth_user_id')
        .where('id', '=', firstId)
        .executeTakeFirstOrThrow()
    ).auth_user_id!
    // 直删 sys_user（模拟 TRUNCATE/直删场景），auth_user 成孤儿
    await db.deleteFrom('sys_user').where('id', '=', firstId).execute()

    const secondId = crypto.randomUUID()
    sysUserIds.push(secondId)
    const secondHashed = await hashPassword('orphan-pass-2')
    await withTx(db, async (trx) => {
      await trx
        .insertInto('sys_user')
        .values({ id: secondId, username, hashed_password: secondHashed })
        .execute()
      await syncUserCredential(trx, { userId: secondId, hashedPassword: secondHashed })
    })
    const relinked = await db
      .selectFrom('sys_user')
      .select('auth_user_id')
      .where('id', '=', secondId)
      .executeTakeFirstOrThrow()
    expect(relinked.auth_user_id).toBe(firstAuthId)
    // 旧密码失效、新密码可登
    await signInCookie(username, 'orphan-pass-1', 401)
    await signInCookie(username, 'orphan-pass-2', 200)
  })

  test('better-auth 兜底 handler：get-session 有 cookie 出会话，旧具体路由不被吞', async () => {
    const { cookie } = await signInCookie(freshUsername, 'fresh-pass-456')
    const session = await app.request('/api/v1/auth/get-session', { headers: { cookie } })
    expect(session.status).toBe(200)
    const data = (await session.json()) as { user?: { username?: string } } | null
    expect(data?.user?.username).toBe(freshUsername.toLowerCase())

    // 旧契约路由仍由具体路由处理（better-auth 对未知 POST /login 会 404）
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: freshUsername, password: 'fresh-pass-456' }),
    })
    expect(login.status).toBe(200)
    expect(((await login.json()) as { token: string }).token).toBeTruthy()
  })

  test('setup status 透出 logtoEnabled', async () => {
    const res = await app.request('/api/v1/setup/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { logtoEnabled: boolean }
    expect(body.logtoEnabled).toBe(false)
  })
})

describePg('Logto 首登 fail-closed 供给钩子（PG 集成）', () => {
  let db: Kysely<Database>
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  const email = `oauth-${suffix}@example.com`
  const sysUserIds: string[] = []
  const authUserIds: string[] = []

  beforeAll(async () => {
    db = createDb(databaseUrl!)
  })

  afterAll(async () => {
    if (sysUserIds.length > 0) {
      await db.deleteFrom('sys_user').where('id', 'in', sysUserIds).execute()
    }
    if (authUserIds.length > 0) {
      await db.deleteFrom('auth_user').where('id', 'in', authUserIds).execute()
    }
    await db.destroy()
  })

  test('email 未命中任何 sys_user：拒绝建号', async () => {
    const provision = createOAuthProvision(db)
    expect(provision.before({ email: `nobody-${suffix}@example.com` })).rejects.toThrow(
      '禁止自动建号',
    )
  })

  test('email 命中未关联 sys_user：放行并回写 auth_user_id', async () => {
    const sysUserId = crypto.randomUUID()
    sysUserIds.push(sysUserId)
    await db
      .insertInto('sys_user')
      .values({
        id: sysUserId,
        username: `oauth${suffix}`,
        name: 'OAuth 供给',
        hashed_password: await hashPassword('irrelevant-123'),
        email,
      })
      .execute()

    const provision = createOAuthProvision(db)
    // 大小写不敏感匹配
    await provision.before({ email: email.toUpperCase() })

    // 模拟 better-auth 建号后 after 回写
    const authUserId = crypto.randomUUID()
    authUserIds.push(authUserId)
    await db
      .insertInto('auth_user')
      .values({ id: authUserId, name: 'OAuth 供给', email, email_verified: true })
      .execute()
    await provision.after({ id: authUserId, email: email.toUpperCase() })

    const linked = await db
      .selectFrom('sys_user')
      .select('auth_user_id')
      .where('id', '=', sysUserId)
      .executeTakeFirstOrThrow()
    expect(linked.auth_user_id).toBe(authUserId)
  })

  test('email 命中但 sys_user 已有登录账号：拒绝建号（不产生悬挂账号）', async () => {
    const provision = createOAuthProvision(db)
    expect(provision.before({ email })).rejects.toThrow('已有登录账号')
  })
})
