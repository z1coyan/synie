/**
 * 部门端点 HTTP 集成（工单 05）：`guard(resource, action)` 的首个真实路由消费者。
 *
 * 断言错误语义唯一规则：未登录 401 / 码不满足 403 forbidden / 行级（公司）不命中 404 not_found。
 * 授权走真实存储（sys_role_permission + sys_user_company），Actor 由装配器现读。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createPlatformRegistry, buildTestApp, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('PG 集成（部门端点 guard）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  /** 建用户走 IamService：superAdmin 现取一张 sysUsers:create 凭证 */
  const adminUserPermit = () => {
    const decision = authz.decideFor(admin, 'sysUsers', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const roleId = crypto.randomUUID()
  let userId = ''
  let headers: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  /** 给测试角色授权（scope 一律 all；每次覆盖式重写） */
  async function grant(codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
        .execute()
    }
  }

  /** path 传 '' 即集合根（Hono 挂载点不匹配尾斜杠） */
  async function post(path: string, body: unknown): Promise<Response> {
    return app.request(`/api/v1/system/departments${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'部门HTTP币-' + suffix}, ${'H' + suffix.slice(0, 2).toUpperCase()}, 'H', true)
    `.execute(db)
    for (const [id, code] of [
      [companyA, 'HA'],
      [companyB, 'HB'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${'部门HTTP公司' + code}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    await db
      .insertInto('sys_role')
      .values({ id: roleId, code: `dept-http-${suffix}`, name: `部门端点角色-${suffix}` })
      .execute()
    const created = await iam.createUser(adminUserPermit(), {
      username: `dept-http-${suffix}`,
      name: '部门端点用户',
      roleIds: [roleId],
      companyIds: [companyA],
    })
    userId = created.user.id

    app = await buildTestApp(db, { registry })
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: created.user.username, password: created.password }),
    })
    const { token } = (await login.json()) as { token: string }
    headers = { authorization: `Bearer ${token}` }
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE actor_id = ${userId}::uuid`.execute(db)
    await sql`DELETE FROM sys_department WHERE company_id = ANY(${[companyA, companyB]}::uuid[])`.execute(db)
    await db.deleteFrom('sys_user_role').where('user_id', '=', userId).execute()
    await db.deleteFrom('sys_user_company').where('user_id', '=', userId).execute()
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    await db.deleteFrom('sys_role').where('id', '=', roleId).execute()
    await sql`DELETE FROM auth_account WHERE user_id IN (SELECT auth_user_id FROM sys_user WHERE id = ${userId}::uuid)`.execute(db)
    await db.deleteFrom('sys_user').where('id', '=', userId).execute()
    await sql`DELETE FROM bas_company WHERE id = ANY(${[companyA, companyB]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('未登录 → 401（guard 挂在 requireAuth 之后）', async () => {
    const res = await app.request('/api/v1/system/departments/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 10, offset: 0 }),
    })
    expect(res.status).toBe(401)
  })

  test('无任何授权码 → 403 forbidden（不是 404）', async () => {
    await grant([])
    const res = await post('/query', { limit: 10, offset: 0 })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'forbidden' },
    })
  })

  test('持 read 可查；持 read 不可建（动作码逐个门控）', async () => {
    await grant(['sys.department:read'])
    expect((await post('/query', { limit: 10, offset: 0 })).status).toBe(200)
    const denied = await post('', { code: `Q1-${suffix}`, name: '越权建部', companyId: companyA })
    expect(denied.status).toBe(403)
  })

  test('持 create 可建；目标公司不在授权集内 → 404（不泄露公司存在性）', async () => {
    await grant(['sys.department:read', 'sys.department:create'])
    const ok = await post('', { name: '端点部', companyId: companyA })
    expect(ok.status).toBe(201)
    const body = (await ok.json()) as {
      id: string
      code: string
      company: { id: string }
      enabled: boolean
    }
    expect(body.company.id).toBe(companyA)
    expect(body.enabled).toBe(true)
    // 编码由系统按迁移预置规则生成（B(D)- + 4 位序号，按公司分桶）
    expect(body.code).toMatch(/^B\(D\)-\d{4}$/)

    const foreign = await post('', { name: '越界部', companyId: companyB })
    expect(foreign.status).toBe(404)
  })

  test('跨公司单条读取 → 404；本公司 → 200', async () => {
    const foreignId = crypto.randomUUID()
    await sql`
      INSERT INTO sys_department (id, company_id, code, name, path)
      VALUES (${foreignId}::uuid, ${companyB}::uuid, ${'FB-' + suffix}, 'B公司部门', ${'/' + foreignId + '/'})
    `.execute(db)
    const denied = await app.request(`/api/v1/system/departments/${foreignId}`, { headers })
    expect(denied.status).toBe(404)

    const mine = await post('/query', { limit: 1, offset: 0 })
    const list = (await mine.json()) as { results: { id: string }[] }
    const own = await app.request(`/api/v1/system/departments/${list.results[0]!.id}`, { headers })
    expect(own.status).toBe(200)
  })

  test('删除需独立的 delete 码', async () => {
    const list = (await (await post('/query', { limit: 1, offset: 0 })).json()) as {
      results: { id: string }[]
    }
    const id = list.results[0]!.id
    const denied = await app.request(`/api/v1/system/departments/${id}`, { method: 'DELETE', headers })
    expect(denied.status).toBe(403)

    await grant(['sys.department:read', 'sys.department:create', 'sys.department:delete'])
    const ok = await app.request(`/api/v1/system/departments/${id}`, { method: 'DELETE', headers })
    expect(ok.status).toBe(204)
  })
})
