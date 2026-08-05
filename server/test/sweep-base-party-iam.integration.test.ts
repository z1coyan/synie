/**
 * 扫荡批 3（工单 09）的授权端到端验收：base / party / iam / platform 杂项。
 *
 * 断言口径（错误语义唯一规则）：动作码不满足 403 forbidden；行级范围不命中
 * 404 not_found / 列表不含；状态不满足 409 conflict（状态守卫划出权限系统）。
 *
 * 本批多数资源是 **global**（币种/单位/公司/客商/员工/地址/用户/角色/行情/模板…）：
 * 它们没有公司列，故无「跨公司 404」，取而代之的断言是
 * **矩阵对该前缀无行级范围**（supportedScopes 只有 all）。
 * 唯一的公司域资源是会计科目（bas_account）与可空公司列的审计日志，
 * 跨公司 404 与 NULL-admitting 语义在它们上验。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

/** 全量码：本批各资源的读 + 科目写（够跑完所有别名回归与状态守卫） */
const FULL_CODES = [
  'base.currency:read',
  'base.currency:create',
  'base.company:read',
  'base.unit:read',
  'base.account:read',
  'base.account:create',
  'base.account:delete',
  'base.customer:read',
  'base.supplier:read',
  'base.party_address:read',
  'hr.employee:read',
  'sys.user:read',
  'sys.role:read',
  'sys.audit_log:read',
  'sys.print_template:read',
  'sys.numbering_rule:read',
  'base.market_instrument:read',
  'base.market_price:read',
] as const

/** 只读角色：故意不含 base.currency:create（缺码 403 用例） */
const READ_ONLY_CODES = FULL_CODES.filter((c) => c !== 'base.currency:create')

run('PG 集成（扫荡 09：base/party/iam/platform 授权语义）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  const adminUserPermit = () => {
    const decision = authz.decideFor(admin, 'sysUsers', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const accountRootA = crypto.randomUUID()
  const accountLeafA = crypto.randomUUID()
  const accountB = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const employeeId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  const auditGlobalId = crypto.randomUUID()
  const auditCompanyBId = crypto.randomUUID()
  const fullRoleId = crypto.randomUUID()
  const readRoleId = crypto.randomUUID()

  let fullUserId = ''
  let readUserId = ''
  let fullHeaders: Record<string, string> = {}
  let readHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  async function grant(roleId: string, codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
        .execute()
    }
  }

  async function login(username: string, password: string): Promise<Record<string, string>> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const { token } = (await res.json()) as { token: string }
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  }

  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { headers })
  const del = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { method: 'DELETE', headers })

  /** 列表路径的别名回归：断言**本公司/本记录在结果里**（只断言别人的不在，对空集永真） */
  async function listIds(path: string, headers: Record<string, string>): Promise<string[]> {
    const res = await post(path, headers, { limit: 200, offset: 0 })
    expect(res.status).toBe(200)
    const parsed = (await res.json()) as { results: Array<{ id: string }> }
    return parsed.results.map((r) => r.id)
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'扫荡币-' + suffix}, ${'S' + suffix.slice(0, 2).toUpperCase()}, 'S', true)
    `.execute(db)
    for (const [id, code, name] of [
      [companyA, 'SA', '扫荡公司甲'],
      [companyB, 'SB', '扫荡公司乙'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${name + suffix}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    // 科目：甲公司根 + 叶（删父 409 用例），乙公司一条（跨公司 404 用例）
    await db
      .insertInto('bas_account')
      .values([
        {
          id: accountRootA,
          code: `SR${suffix}`,
          name: `扫荡根-${suffix}`,
          direction: 'debit',
          is_group: true,
          active: true,
          company_id: companyA,
        },
        {
          id: accountLeafA,
          code: `SL${suffix}`,
          name: `扫荡叶-${suffix}`,
          direction: 'debit',
          is_group: false,
          active: true,
          company_id: companyA,
          parent_id: accountRootA,
        },
        {
          id: accountB,
          code: `SB${suffix}`,
          name: `乙司科目-${suffix}`,
          direction: 'debit',
          is_group: false,
          active: true,
          company_id: companyB,
        },
      ])
      .execute()
    await db
      .insertInto('sal_customers')
      .values({ id: customerId, code: `SC${suffix}`, name: `扫荡客户-${suffix}` })
      .execute()
    await db
      .insertInto('pur_supplier')
      .values({ id: supplierId, code: `SS${suffix}`, name: `扫荡供应商-${suffix}` })
      .execute()
    await db
      .insertInto('hr_employees')
      .values({ id: employeeId, code: `SE${suffix}`, name: `扫荡员工-${suffix}` })
      .execute()
    await db
      .insertInto('bas_party_address')
      .values({
        id: addressId,
        party_type: 'customer',
        party_id: customerId,
        name: `扫荡地址-${suffix}`,
        purpose: 'shipping',
        province: '浙江省',
        city: '台州市',
        district: '路桥区',
        address: '测试路 1 号',
      })
      .execute()
    // 审计：一条全局（company_id NULL）+ 一条乙公司（nullable 声明的语义验证）
    await db
      .insertInto('sys_audit_log')
      .values([
        {
          id: auditGlobalId,
          resource: 'sweep_probe',
          record_id: crypto.randomUUID(),
          action_type: 'update',
          action_name: 'probe_global',
          company_id: null,
          changes: sql`'{}'::jsonb`,
        },
        {
          id: auditCompanyBId,
          resource: 'sweep_probe',
          record_id: crypto.randomUUID(),
          action_type: 'update',
          action_name: 'probe_company_b',
          company_id: companyB,
          changes: sql`'{}'::jsonb`,
        },
      ])
      .execute()
    await db
      .insertInto('sys_role')
      .values([
        { id: fullRoleId, code: `sweep-full-${suffix}`, name: `扫荡全量-${suffix}` },
        { id: readRoleId, code: `sweep-read-${suffix}`, name: `扫荡只读-${suffix}` },
      ])
      .execute()
    await grant(fullRoleId, FULL_CODES)
    await grant(readRoleId, READ_ONLY_CODES)

    app = await buildTestApp(db)
    // 两个用户都只授权公司甲：公司域资源（科目/审计）的跨公司边界由此可验
    const full = await iam.createUser(adminUserPermit(), {
      username: `sweep-full-${suffix}`,
      name: '扫荡全量',
      roleIds: [fullRoleId],
      companyIds: [companyA],
    })
    fullUserId = full.user.id
    fullHeaders = await login(`sweep-full-${suffix}`, full.password)
    const readOnly = await iam.createUser(adminUserPermit(), {
      username: `sweep-read-${suffix}`,
      name: '扫荡只读',
      roleIds: [readRoleId],
      companyIds: [companyA],
    })
    readUserId = readOnly.user.id
    readHeaders = await login(`sweep-read-${suffix}`, readOnly.password)
  })

  afterAll(async () => {
    for (const id of [fullUserId, readUserId]) {
      if (!id) continue
      await db.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      const row = await db
        .selectFrom('sys_user')
        .select('auth_user_id')
        .where('id', '=', id)
        .executeTakeFirst()
      await db.deleteFrom('sys_user').where('id', '=', id).execute()
      if (row?.auth_user_id) {
        await db.deleteFrom('auth_user').where('id', '=', row.auth_user_id).execute()
      }
    }
    await db.deleteFrom('sys_role_permission').where('role_id', 'in', [fullRoleId, readRoleId]).execute()
    await db.deleteFrom('sys_role').where('id', 'in', [fullRoleId, readRoleId]).execute()
    await db.deleteFrom('sys_audit_log').where('resource', '=', 'sweep_probe').execute()
    await db.deleteFrom('bas_party_address').where('id', '=', addressId).execute()
    await db.deleteFrom('hr_employees').where('id', '=', employeeId).execute()
    await db.deleteFrom('pur_supplier').where('id', '=', supplierId).execute()
    await db.deleteFrom('sal_customers').where('id', '=', customerId).execute()
    for (const id of [accountLeafA, accountRootA, accountB]) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('bas_account').where('id', '=', id).execute()
    }
    for (const id of [companyA, companyB]) {
      await db.deleteFrom('sys_audit_log').where('company_id', '=', id).execute()
      await db.deleteFrom('inv_warehouse').where('company_id', '=', id).execute()
      await db.deleteFrom('bas_company').where('id', '=', id).execute()
    }
    await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    await db.destroy()
  })

  test('别名回归：每条列表路径都能看到本人可达的行（不只断言别人的不在）', async () => {
    // 裸表别名（bas_currency / bas_unit / sal_customers / …）
    expect(await listIds('/base/currencies/query', fullHeaders)).toContain(currencyId)
    expect(await listIds('/base/customers/query', fullHeaders)).toContain(customerId)
    expect(await listIds('/base/suppliers/query', fullHeaders)).toContain(supplierId)
    expect(await listIds('/hr/employees/query', fullHeaders)).toContain(employeeId)
    expect(await listIds('/base/party-addresses/query', fullHeaders)).toContain(addressId)
    // 子查询别名（company / account / sys_user）——写错别名会静默变空集
    expect(await listIds('/base/companies/query', fullHeaders)).toContain(companyA)
    expect(await listIds('/base/accounts/query', fullHeaders)).toContain(accountRootA)
    expect(await listIds('/system/users/query', fullHeaders)).toContain(fullUserId)
    expect(await listIds('/system/roles/query', fullHeaders)).toContain(fullRoleId)
    // platform 余量：审计（nullable 公司列）与编号/模板/行情
    const auditIds = await listIds('/system/audit-logs/query', fullHeaders)
    expect(auditIds).toContain(auditGlobalId)
    for (const path of [
      '/system/numbering/rules/query',
      '/system/printing/templates/query',
      '/base/market-instruments/query',
      '/base/market-price-points/query',
    ]) {
      const res = await post(path, fullHeaders, { limit: 5, offset: 0 })
      expect(res.status).toBe(200)
    }
  })

  test('公司域：跨公司单条 404、列表不含（科目）', async () => {
    // 只授权公司甲：乙公司科目「存在但不可达」→ not_found，不泄露存在性
    const cross = await get(`/base/accounts/${accountB}`, fullHeaders)
    expect(cross.status).toBe(404)
    expect(await listIds('/base/accounts/query', fullHeaders)).not.toContain(accountB)
    // 本公司同一路径可达（别名回归的对照）
    expect((await get(`/base/accounts/${accountRootA}`, fullHeaders)).status).toBe(200)
  })

  test('可空公司列（audit nullable）：全局事件可见，他司事件不可见', async () => {
    const ids = await listIds('/system/audit-logs/query', fullHeaders)
    expect(ids).toContain(auditGlobalId)
    expect(ids).not.toContain(auditCompanyBId)
    expect((await get(`/system/audit-logs/${auditGlobalId}`, fullHeaders)).status).toBe(200)
    expect((await get(`/system/audit-logs/${auditCompanyBId}`, fullHeaders)).status).toBe(404)
  })

  test('缺码 403：403 的唯一成因是动作码不满足', async () => {
    const denied = await post('/base/currencies', readHeaders, {
      name: `不该建-${suffix}`,
      isoCode: 'ZZZ',
    })
    expect(denied.status).toBe(403)
    const body = (await denied.json()) as { error: { code: string } }
    expect(body.error.code).toBe('forbidden')
  })

  test('状态守卫 409：领域不变量没有被卷进权限系统', async () => {
    // 有子科目不可删：conflict（不是 forbidden、也不是 not_found）
    const res = await del(`/base/accounts/${accountRootA}`, fullHeaders)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('conflict')
  })

  test('global 资源：矩阵不开行级范围（supportedScopes 只有 all）', async () => {
    const res = await get('/meta/permission-catalog', fullHeaders)
    expect(res.status).toBe(200)
    const catalog = (await res.json()) as {
      groups: { prefix: string; supportedScopes: string[] }[]
    }
    const globalPrefixes = [
      'base.currency',
      'base.company',
      'base.unit',
      'base.customer',
      'base.supplier',
      'hr.employee',
      'base.party_address',
      'sys.user',
      'sys.role',
      'sys.print_template',
      'sys.numbering_rule',
      'base.market_instrument',
      'base.market_price',
    ]
    for (const prefix of globalPrefixes) {
      const group = catalog.groups.find((g) => g.prefix === prefix)
      expect(group, `权限目录缺少前缀 ${prefix}`).toBeTruthy()
      expect(group!.supportedScopes, `${prefix} 不应开放行级范围`).toEqual(['all'])
    }
    // 公司域资源同样无 owner/dept 声明，也只应授出 all
    expect(catalog.groups.find((g) => g.prefix === 'base.account')?.supportedScopes).toEqual(['all'])
    expect(catalog.groups.find((g) => g.prefix === 'sys.audit_log')?.supportedScopes).toEqual(['all'])
  })

  test('打印 S9：客户端 prefix 经目录解析；不在目录内即 400', async () => {
    const bogus = await post('/printing/render', fullHeaders, {
      resource: 'no.such_resource',
      mode: 'print',
      templateId: crypto.randomUUID(),
      ids: [crypto.randomUUID()],
    })
    // ApiError.validation 是 400（不是 422）
    expect(bogus.status).toBe(400)
    const body = (await bogus.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation')
  })
})
