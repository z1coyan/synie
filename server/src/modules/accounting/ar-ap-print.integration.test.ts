/**
 * 应收应付模板导出 HTTP：阅读仍 acc.gl_entry:read；导出要 acc.ar_ap:export + read。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from '../../../test/helpers.ts'
import { createEntryService } from './entry-service.ts'
import { createJournalService } from './journal-service.ts'

const dbUrl = testDatabaseUrl()
const describeIf = dbUrl ? describe : describe.skip

function arApTemplate(): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>\${as_of}</t></is></c><c r="B1" t="inlineStr"><is><t>\${perspective}</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>\${rows.party_label}</t></is></c><c r="B2" t="inlineStr"><is><t>\${rows.receivable}</t></is></c></row></sheetData></worksheet>`,
    ),
  })
}

describeIf('PG 集成（应收应付模板导出权限）', () => {
  const db = createDb(dbUrl!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const journals = createJournalService(db, numbering, createGlEngine(), registry)
  const entries = createEntryService(db, registry)
  const adminActor = testActor({
    userId: '',
    username: 'arap-print-admin',
    name: '应收应付打印夹具',
    superAdmin: true,
    allCompanies: true,
  })
  const adminPermit = (resource: string, action: string) => {
    const decision = authz.decideFor(adminActor, resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const readRoleId = crypto.randomUUID()
  const exportRoleId = crypto.randomUUID()
  const bothRoleId = crypto.randomUUID()
  const userIds: string[] = []
  const journalIds: string[] = []
  const accountIds: string[] = []
  const companyIds: string[] = []
  let currencyId = ''
  let customerId = ''
  let companyA = ''
  let companyB = ''
  let customerName = ''
  let templateId: string | null = null
  let fileId: string | null = null
  let app: Awaited<ReturnType<typeof buildTestApp>>
  let readHeaders: Record<string, string> = {}
  let exportHeaders: Record<string, string> = {}
  let bothHeaders: Record<string, string> = {}
  let adminHeaders: Record<string, string> = {}

  async function grant(roleId: string, codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length === 0) return
    await db
      .insertInto('sys_role_permission')
      .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
      .execute()
  }

  async function login(username: string, password: string): Promise<Record<string, string>> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const body = (await res.json()) as { token?: string }
    if (!body.token) throw new Error(`login failed: ${username}`)
    return { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' }
  }

  beforeAll(async () => {
    const existing = await db
      .selectFrom('sys_storage')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirst()
    if (!existing) {
      const root = join(tmpdir(), `synie-arap-print-${suffix}`)
      mkdirSync(root, { recursive: true })
      await db
        .insertInto('sys_storage')
        .values({
          name: `arap_print_${suffix}`,
          label: '应收应付打印测试存储',
          kind: 'local',
          root,
          is_default: true,
        })
        .execute()
    }

    const numberingRule = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'acc.gl_journal')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!numberingRule) {
      await numbering.create(adminPermit('sysNumberingRules', 'create'), {
        resource: 'acc.gl_journal',
        name: `凭证编号-AP${suffix.slice(0, 6)}`,
        segments: [{ type: 'text', value: 'T(AP)-' }, { type: 'seq', padding: 4 }],
        perCompany: false,
      })
    }

    const currency = await db
      .insertInto('bas_currency')
      .values({
        name: `AP打印币${suffix}`,
        iso_code: suffix.slice(0, 3).toUpperCase(),
        symbol: '¤',
        active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    currencyId = currency.id

    const companyRowA = await db
      .insertInto('bas_company')
      .values({
        code: suffix.slice(0, 2).toUpperCase(),
        name: `AP打印甲${suffix}`,
        short_name: '甲',
        base_currency_id: currencyId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    companyA = companyRowA.id
    companyIds.push(companyA)

    const companyRowB = await db
      .insertInto('bas_company')
      .values({
        code: suffix.slice(2, 4).toUpperCase() || 'ZB',
        name: `AP打印乙${suffix}`,
        short_name: '乙',
        base_currency_id: currencyId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    companyB = companyRowB.id
    companyIds.push(companyB)

    const receivable = await db
      .insertInto('bas_account')
      .values({
        code: `${suffix}1122`,
        name: `AP打印应收${suffix}`,
        direction: 'debit',
        is_group: false,
        active: true,
        company_id: companyA,
        currency_id: currencyId,
        role: 'receivable',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    accountIds.push(receivable.id)

    const cash = await db
      .insertInto('bas_account')
      .values({
        code: `${suffix}1001`,
        name: `AP打印现金${suffix}`,
        direction: 'debit',
        is_group: false,
        active: true,
        company_id: companyA,
        currency_id: currencyId,
        role: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    accountIds.push(cash.id)

    const customer = await db
      .insertInto('sal_customers')
      .values({ code: `APC${suffix}`, name: `AP打印客户${suffix}`, short_name: null })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow()
    customerId = customer.id
    customerName = customer.name

    const journalPermit = adminPermit('accGlJournals', 'read')
    const linePermit = adminPermit('accGlJournalLines', 'read')
    const journal = await journals.create(journalPermit, {
      date: '2026-07-26',
      companyId: companyA,
    })
    journalIds.push(journal.id)
    await journals.createLine(linePermit, {
      journalId: journal.id,
      idx: 1,
      accountId: receivable.id,
      debit: '125.50',
      credit: '0',
      partyType: 'CUSTOMER',
      partyId: customerId,
    })
    await journals.createLine(linePermit, {
      journalId: journal.id,
      idx: 2,
      accountId: cash.id,
      debit: '0',
      credit: '125.50',
    })
    await journals.audit(journalPermit, journal.id, '2026-07-26')

    for (const [id, code, name] of [
      [readRoleId, `arap-read-${suffix}`, '仅分录查看'],
      [exportRoleId, `arap-export-${suffix}`, '仅导出'],
      [bothRoleId, `arap-both-${suffix}`, '查看+导出'],
    ] as const) {
      await db.insertInto('sys_role').values({ id, code, name }).execute()
    }
    await grant(readRoleId, ['acc.gl_entry:read'])
    await grant(exportRoleId, ['acc.ar_ap:export'])
    await grant(bothRoleId, ['acc.gl_entry:read', 'acc.ar_ap:export'])

    app = await buildTestApp(db, { registry })
    const adminCreated = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `arap-admin-${suffix}`,
      name: '应收应付打印超管',
    })
    await db
      .updateTable('sys_user')
      .set({ super_admin: true, all_companies: true })
      .where('id', '=', adminCreated.user.id)
      .execute()
    userIds.push(adminCreated.user.id)
    adminHeaders = await login(adminCreated.user.username, adminCreated.password)

    const readUser = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `arap-ro-${suffix}`,
      name: '仅查看',
      roleIds: [readRoleId],
      companyIds: [companyA],
    })
    const exportUser = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `arap-ex-${suffix}`,
      name: '仅导出',
      roleIds: [exportRoleId],
      companyIds: [companyA],
    })
    const bothUser = await iam.createUser(adminPermit('sysUsers', 'create'), {
      username: `arap-both-${suffix}`,
      name: '查看导出',
      roleIds: [bothRoleId],
      companyIds: [companyA],
    })
    userIds.push(readUser.user.id, exportUser.user.id, bothUser.user.id)
    readHeaders = await login(readUser.user.username, readUser.password)
    exportHeaders = await login(exportUser.user.username, exportUser.password)
    bothHeaders = await login(bothUser.user.username, bothUser.password)

    const form = new FormData()
    form.append(
      'file',
      new Blob([arApTemplate()], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      `arap-${suffix}.xlsx`,
    )
    const uploadRes = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { Authorization: adminHeaders.authorization! },
      body: form,
    })
    if (uploadRes.status !== 201) throw new Error(`upload failed ${uploadRes.status}`)
    fileId = ((await uploadRes.json()) as { file: { id: string } }).file.id

    const createRes = await app.request('/api/v1/system/printing/templates', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: `应收应付打印-${suffix}`,
        resource: 'acc.ar_ap',
        fileId,
      }),
    })
    if (createRes.status !== 201) throw new Error(`template create failed ${createRes.status}`)
    templateId = ((await createRes.json()) as { id: string }).id
  })

  afterAll(async () => {
    if (templateId) {
      await app.request(`/api/v1/system/printing/templates/${templateId}`, {
        method: 'DELETE',
        headers: adminHeaders,
      })
    }
    if (fileId) {
      await app.request(`/api/v1/files/${fileId}`, {
        method: 'DELETE',
        headers: adminHeaders,
      })
    }
    for (const id of journalIds) {
      await db.deleteFrom('acc_gl_entry').where('voucher_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('acc_gl_journal_line').where('journal_id', '=', id).execute()
      await db.deleteFrom('acc_gl_journal').where('id', '=', id).execute()
    }
    if (customerId) await db.deleteFrom('sal_customers').where('id', '=', customerId).execute()
    for (const id of accountIds) await db.deleteFrom('bas_account').where('id', '=', id).execute()
    if (userIds.length > 0) {
      await db.deleteFrom('sys_audit_log').where('actor_id', 'in', userIds).execute()
      await db.deleteFrom('sys_user_role').where('user_id', 'in', userIds).execute()
      await db.deleteFrom('sys_user_company').where('user_id', 'in', userIds).execute()
      await sql`
        DELETE FROM auth_account
        WHERE user_id IN (SELECT auth_user_id FROM sys_user WHERE id = ANY(${userIds}::uuid[]))
      `.execute(db)
      await db.deleteFrom('sys_user').where('id', 'in', userIds).execute()
    }
    await db.deleteFrom('sys_role_permission').where('role_id', 'in', [readRoleId, exportRoleId, bothRoleId]).execute()
    await db.deleteFrom('sys_role').where('id', 'in', [readRoleId, exportRoleId, bothRoleId]).execute()
    for (const id of companyIds) await db.deleteFrom('bas_company').where('id', '=', id).execute()
    if (currencyId) await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    await db.destroy()
  })

  function reportUrl(companyId: string) {
    return `/api/v1/accounting/ar-ap-report?companyId=${companyId}&asOf=2026-07-31`
  }

  function renderBody(companyId: string) {
    return {
      resource: 'acc.ar_ap',
      mode: 'export',
      templateId,
      context: { companyId, asOf: '2026-07-31', side: 'ar' },
    }
  }

  test('仅有分录查看：能读报表，导出 403', async () => {
    const report = await app.request(reportUrl(companyA), { headers: readHeaders })
    expect(report.status).toBe(200)
    const body = (await report.json()) as { rows: Array<{ partyId: string; balances: { receivable: string } }> }
    const row = body.rows.find((r) => r.partyId === customerId)
    expect(Number(row?.balances.receivable)).toBe(125.5)

    const rendered = await app.request('/api/v1/printing/render', {
      method: 'POST',
      headers: readHeaders,
      body: JSON.stringify(renderBody(companyA)),
    })
    expect(rendered.status).toBe(403)
  })

  test('仅有导出、无分录查看：读报表与导出都 403', async () => {
    expect((await app.request(reportUrl(companyA), { headers: exportHeaders })).status).toBe(403)
    const rendered = await app.request('/api/v1/printing/render', {
      method: 'POST',
      headers: exportHeaders,
      body: JSON.stringify(renderBody(companyA)),
    })
    expect(rendered.status).toBe(403)
  })

  test('查看+导出：导出 200 且数字与报表查询一致', async () => {
    const report = await entries.report(adminPermit('accGlEntries', 'read'), {
      companyId: companyA,
      asOf: '2026-07-31',
    })
    const expected = report.rows.find((r) => r.partyId === customerId)
    expect(Number(expected?.balances.receivable)).toBe(125.5)

    const rendered = await app.request('/api/v1/printing/render', {
      method: 'POST',
      headers: bothHeaders,
      body: JSON.stringify(renderBody(companyA)),
    })
    expect(rendered.status).toBe(200)
    expect(rendered.headers.get('content-type')).toContain('spreadsheetml')
    const zip = unzipSync(new Uint8Array(await rendered.arrayBuffer()))
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('2026-07-31')
    expect(sheet).toContain('应收')
    expect(sheet).toContain(customerName)
    expect(sheet).toContain('125.5')

    const printed = await app.request('/api/v1/printing/render', {
      method: 'POST',
      headers: bothHeaders,
      body: JSON.stringify({ ...renderBody(companyA), mode: 'print' }),
    })
    expect(printed.status).toBe(403)
  })

  test('公司不在授权范围：报表与导出都空结果，不是 403', async () => {
    const report = await app.request(reportUrl(companyB), { headers: bothHeaders })
    expect(report.status).toBe(200)
    const body = (await report.json()) as { rows: unknown[] }
    expect(body.rows).toEqual([])

    const rendered = await app.request('/api/v1/printing/render', {
      method: 'POST',
      headers: bothHeaders,
      body: JSON.stringify(renderBody(companyB)),
    })
    expect(rendered.status).toBe(200)
    const zip = unzipSync(new Uint8Array(await rendered.arrayBuffer()))
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']!)
    expect(sheet).not.toContain(customerName)
    expect(sheet).not.toContain('125.5')
  })
})
