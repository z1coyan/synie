/**
 * 发票红冲 HTTP 行为（权限收口）：走真实登录 + sys_role_permission 装配。
 *
 * 产品锁定：红冲开新红字分录、原单保留；能力是 create，不是 void。
 * 不发明第九动作。仅作废不能红冲；存量 reverse 折进 create。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

run('HTTP 红冲：create 才能红冲，原单保留且新开红字', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })

  const adminPermit = (resource: string, action: string) => {
    const decision = authz.decideFor(admin, resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  const day = '2099-08-20'
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const employeeId = crypto.randomUUID()
  const partyAccountId = crypto.randomUUID()
  const amountAccountId = crypto.randomUUID()
  const taxAccountId = crypto.randomUUID()
  const roleId = crypto.randomUUID()
  let numberingRuleId: string | null = null
  let userId = ''
  let headers: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  async function grant(codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length === 0) return
    await db
      .insertInto('sys_role_permission')
      .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
      .execute()
  }

  function jsonHeaders(): Record<string, string> {
    return { ...headers, 'content-type': 'application/json' }
  }

  function post(path: string, body: unknown = {}): Promise<Response> {
    return app.request(`/api/v1${path}`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    })
  }

  function get(path: string): Promise<Response> {
    return app.request(`/api/v1${path}`, { headers })
  }

  async function errorCode(res: Response): Promise<string> {
    const body = (await res.json()) as { error?: { code?: string } }
    return body.error?.code ?? ''
  }

  async function openAuditedInvoice(invoiceNo: string): Promise<string> {
    await grant(['acc.vat_invoice:read', 'acc.vat_invoice:create', 'acc.vat_invoice:audit'])
    const created = await post('/finance/vat-invoices', {
      companyId,
      direction: 'INBOUND',
      partyType: 'EMPLOYEE',
      partyId: employeeId,
      invoiceKind: 'SPECIAL',
      invoiceDate: day,
      invoiceCode: `RC${suffix}${invoiceNo}`,
      invoiceNo,
      items: [],
      netTotal: '90',
      taxTotal: '10',
      grossTotal: '100',
      partyAccountId,
      amountAccountId,
      taxAccountId,
    })
    expect([invoiceNo, created.status]).toEqual([invoiceNo, 201])
    const { id } = (await created.json()) as { id: string }
    const audited = await post(`/finance/vat-invoices/${id}/audit`, { postingDate: day })
    expect([invoiceNo, audited.status]).toEqual([invoiceNo, 200])
    return id
  }

  async function listInvoiceIds(): Promise<string[]> {
    const res = await post('/finance/vat-invoices/query', { limit: 50, offset: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ id: string }> }
    return body.results.map((row) => row.id)
  }

  async function listEntries(voucherId: string): Promise<
    Array<{ id: string; voucherId: string; isReversed: boolean; isReversal: boolean }>
  > {
    const res = await post('/accounting/gl-entries/query', { limit: 200, offset: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ id: string; voucherId: string; isReversed: boolean; isReversal: boolean }>
    }
    return body.results.filter((row) => row.voucherId === voucherId)
  }

  beforeAll(async () => {
    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'acc.vat_invoice')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existing) {
      const rule = await numbering.create(adminPermit('sysNumberingRules', 'create'), {
        resource: 'acc.vat_invoice',
        name: `发票编号-HTTP${suffix}`,
        segments: [{ type: 'text', value: `H(I)${suffix}-` }, { type: 'seq', padding: 4 }],
        perCompany: false,
      })
      numberingRuleId = rule.id
    }

    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'红冲HTTP币-' + suffix}, ${'R' + suffix.slice(0, 2)}, 'R', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
      VALUES (${companyId}::uuid, ${'RH' + suffix}, ${'红冲HTTP公司' + suffix}, 'RH', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO hr_employees (id, code, name)
      VALUES (${employeeId}::uuid, ${'E' + suffix}, ${'红冲HTTP员工' + suffix})
    `.execute(db)
    await sql`
      INSERT INTO bas_account (id, code, name, direction, is_group, active, company_id, currency_id, role)
      VALUES
        (${partyAccountId}::uuid, ${'P' + suffix}, ${'应付' + suffix}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'other_payable'),
        (${amountAccountId}::uuid, ${'A' + suffix}, ${'费用' + suffix}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${taxAccountId}::uuid, ${'T' + suffix}, ${'税额' + suffix}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await db
      .insertInto('sys_role')
      .values({ id: roleId, code: `inv-rev-${suffix}`, name: `红冲HTTP角色-${suffix}` })
      .execute()
    const created = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `inv-rev-${suffix}`,
      name: '红冲HTTP用户',
      roleIds: [roleId],
      companyIds: [companyId],
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
    await sql`DELETE FROM acc_gl_entry WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_vat_invoice WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE actor_id = ${userId}::uuid OR company_id = ${companyId}::uuid`.execute(
      db,
    )
    await db.deleteFrom('sys_user_role').where('user_id', '=', userId).execute()
    await db.deleteFrom('sys_user_company').where('user_id', '=', userId).execute()
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    await db.deleteFrom('sys_role').where('id', '=', roleId).execute()
    await sql`DELETE FROM auth_account WHERE user_id IN (SELECT auth_user_id FROM sys_user WHERE id = ${userId}::uuid)`.execute(
      db,
    )
    await db.deleteFrom('sys_user').where('id', '=', userId).execute()
    await sql`DELETE FROM bas_account WHERE company_id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM hr_employees WHERE id = ${employeeId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id = ${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    if (numberingRuleId) {
      await sql`DELETE FROM sys_numbering_counter WHERE rule_id = ${numberingRuleId}::uuid`.execute(db)
      await sql`DELETE FROM sys_numbering_rule WHERE id = ${numberingRuleId}::uuid`.execute(db)
    }
    await db.destroy()
  })

  test('仅作废不能红冲', async () => {
    const id = await openAuditedInvoice(`V${suffix}`)
    await grant(['acc.vat_invoice:read', 'acc.vat_invoice:void'])
    const denied = await post(`/finance/vat-invoices/${id}/reverse`, { postingDate: day })
    expect(denied.status).toBe(403)
    expect(await errorCode(denied)).toBe('forbidden')

    const original = (await (await get(`/finance/vat-invoices/${id}`)).json()) as {
      id: string
      status: string
    }
    expect(original.id).toBe(id)
    expect(original.status).toBe('AUDITED')
  })

  test('存量 reverse 折进 create、不折进 void；红冲后原单仍在且新开红字分录', async () => {
    const id = await openAuditedInvoice(`L${suffix}`)
    const beforeIds = await listInvoiceIds()
    expect(beforeIds).toContain(id)

    await grant([
      'acc.vat_invoice:read',
      'acc.vat_invoice:reverse',
      'acc.gl_entry:read',
    ])
    const voidDenied = await post(`/finance/vat-invoices/${id}/void`)
    expect(voidDenied.status).toBe(403)
    expect(await errorCode(voidDenied)).toBe('forbidden')

    const reversed = await post(`/finance/vat-invoices/${id}/reverse`, {
      postingDate: day,
      redInvoiceNo: `RED${suffix}`,
    })
    expect(reversed.status).toBe(200)
    const body = (await reversed.json()) as { id: string; status: string; redInvoiceNo: string | null }
    expect(body.id).toBe(id)
    expect(body.status).toBe('REVERSED')
    expect(body.redInvoiceNo).toBe(`RED${suffix}`)

    const stillThere = await get(`/finance/vat-invoices/${id}`)
    expect(stillThere.status).toBe(200)
    const original = (await stillThere.json()) as { id: string; status: string }
    expect(original.id).toBe(id)
    expect(original.status).toBe('REVERSED')

    const afterIds = await listInvoiceIds()
    expect(afterIds).toContain(id)
    expect(afterIds.length).toBe(beforeIds.length)

    const entries = await listEntries(id)
    const originals = entries.filter((row) => row.isReversed && !row.isReversal)
    const reds = entries.filter((row) => row.isReversal)
    expect(originals.length).toBeGreaterThan(0)
    expect(reds.length).toBeGreaterThan(0)
    expect(reds.every((row) => row.voucherId === id)).toBe(true)
  })

  test('八动作 create 可红冲：原单保留、新开红字分录', async () => {
    const id = await openAuditedInvoice(`C${suffix}`)
    await grant([
      'acc.vat_invoice:read',
      'acc.vat_invoice:create',
      'acc.gl_entry:read',
    ])
    const reversed = await post(`/finance/vat-invoices/${id}/reverse`, { postingDate: day })
    expect(reversed.status).toBe(200)
    const body = (await reversed.json()) as { id: string; status: string }
    expect(body.id).toBe(id)
    expect(body.status).toBe('REVERSED')

    const original = (await (await get(`/finance/vat-invoices/${id}`)).json()) as {
      id: string
      status: string
    }
    expect(original.id).toBe(id)
    expect(original.status).toBe('REVERSED')

    const entries = await listEntries(id)
    expect(entries.some((row) => row.isReversed && !row.isReversal)).toBe(true)
    expect(entries.some((row) => row.isReversal)).toBe(true)
  })
})
