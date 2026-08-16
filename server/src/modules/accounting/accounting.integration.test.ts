/**
 * 手工会计凭证 / 总账分录 / 应收应付报表 PG 集成测试。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createEntryService } from './entry-service.ts'
import { createJournalService } from './journal-service.ts'
import { testActor } from '~/platform/authz/testing.ts'


/** sealed registry 同时供编号与 authz 执行面消费（授权归宿解析） */
const numberingRegistry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（手工会计凭证 / 往来报表）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(numberingRegistry), numberingRegistry)
  const gl = createGlEngine()
  const authz = createAuthzEnforcer(numberingRegistry)
  const journals = createJournalService(db, numbering, gl, numberingRegistry)
  const entries = createEntryService(db, numberingRegistry)
  // userId 空串：不写 created_by/submitted_by FK（避免伪造不存在的 sys_user）
  const actor: Actor = testActor({
    userId: '',
    username: 'gl-journal-test',
    name: '凭证测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  /**
   * 本文件只验领域行为（草稿门/借贷校验/落章/报表口径），superAdmin 凭证的 rowFilter 恒全集；
   * 逐动作码门控与公司边界见 server/test/sweep-finance-accounting-hr.integration.test.ts。凭证每次现取。
   */
  const permit = (resource: string, action: string): Permit => {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }
  const journalPermit = () => permit('accGlJournals', 'read')
  const linePermit = () => permit('accGlJournalLines', 'read')
  const entryPermit = () => permit('accGlEntries', 'read')

  beforeAll(async () => {
    // 凭证编号改系统生成后须持有启用规则（共享库规则可能被清；幂等补建）
    const existing = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'acc.gl_journal')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existing) {
      await numbering.create(permit('sysNumberingRules', 'create'), {
        resource: 'acc.gl_journal',
        name: `凭证编号-T${crypto.randomUUID().slice(0, 6)}`,
        segments: [{ type: 'text', value: 'T(J)-' }, { type: 'seq', padding: 4 }],
        perCompany: false,
      })
    }
  })

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  const prefix = `GLJ${suffix}`
  const cleanupIds = {
    journals: [] as string[],
    lines: [] as string[],
    entries: [] as string[],
    accounts: [] as string[],
    companies: [] as string[],
    currencies: [] as string[],
    customers: [] as string[],
  }

  afterAll(async () => {
    for (const id of cleanupIds.journals) {
      await db
        .deleteFrom('acc_gl_entry')
        .where('voucher_type', '=', 'acc.gl_journal')
        .where('voucher_id', '=', id)
        .execute()
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('acc_gl_journal_line').where('journal_id', '=', id).execute()
      await db.deleteFrom('acc_gl_journal').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.lines) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('acc_gl_journal_line').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.customers) {
      await db.deleteFrom('sal_customers').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.accounts) {
      await db.deleteFrom('bas_account').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.companies) {
      await db.deleteFrom('bas_company').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.currencies) {
      await db.deleteFrom('bas_currency').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  async function seedFixture() {
    const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()
    const currency = await db
      .insertInto('bas_currency')
      .values({
        name: `${prefix}${tag}币种`,
        iso_code: tag.slice(0, 3),
        symbol: '¤',
        active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    cleanupIds.currencies.push(currency.id)

    // 公司编号两位字母唯一（与 bas_company 惯例一致）
    const companyCode = tag.slice(0, 2)
    const company = await db
      .insertInto('bas_company')
      .values({
        code: companyCode,
        name: `${prefix}${tag}公司`,
        short_name: tag.slice(0, 4),
        base_currency_id: currency.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    cleanupIds.companies.push(company.id)

    const receivable = await db
      .insertInto('bas_account')
      .values({
        code: `${tag}1122`,
        name: `${prefix}${tag}应收`,
        direction: 'debit',
        is_group: false,
        active: true,
        company_id: company.id,
        currency_id: currency.id,
        role: 'receivable',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    cleanupIds.accounts.push(receivable.id)

    const cash = await db
      .insertInto('bas_account')
      .values({
        code: `${tag}1001`,
        name: `${prefix}${tag}现金`,
        direction: 'debit',
        is_group: false,
        active: true,
        company_id: company.id,
        currency_id: currency.id,
        role: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    cleanupIds.accounts.push(cash.id)

    const customer = await db
      .insertInto('sal_customers')
      .values({ code: `${prefix}${tag}C`, name: `${prefix}${tag}客户`, short_name: null })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow()
    cleanupIds.customers.push(customer.id)

    return {
      companyId: company.id,
      receivableId: receivable.id,
      cashId: cash.id,
      customerId: customer.id,
      customerName: customer.name,
      currencyId: currency.id,
    }
  }

  test('草稿→审核→取消状态机 + 分录/报表轧差', async () => {
    const fx = await seedFixture()
    const date = '2026-07-26'

    const journal = await journals.create(journalPermit(), {
      date,
      companyId: fx.companyId,
      remarks: `${prefix}创建`,
    })
    cleanupIds.journals.push(journal.id)
    expect(journal.status).toBe('DRAFT')
    expect(journal.company.id).toBe(fx.companyId)

    const debit = await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 1,
      accountId: fx.receivableId,
      debit: '125.50',
      credit: '0',
      partyType: 'CUSTOMER',
      partyId: fx.customerId,
      remarks: `${prefix}应收`,
    })
    cleanupIds.lines.push(debit.id)
    expect(debit.currencyId).toBe(fx.currencyId)
    expect(debit.partyType).toBe('CUSTOMER')

    const credit = await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 2,
      accountId: fx.cashId,
      debit: '0',
      credit: '125.50',
      remarks: `${prefix}对方`,
    })
    cleanupIds.lines.push(credit.id)

    // 草稿可改备注
    const updated = await journals.update(journalPermit(), journal.id, {
      remarks: `${prefix}已更新`,
      remarksPresent: true,
    })
    expect(updated.remarks).toBe(`${prefix}已更新`)

    const audited = await journals.audit(journalPermit(), journal.id, date)
    expect(audited.status).toBe('AUDITED')
    expect(audited.postingDate).toBe(date)
    expect(audited.submittedAt).not.toBeNull()
    expect(Number(audited.debitTotal)).toBe(125.5)
    expect(Number(audited.creditTotal)).toBe(125.5)

    const entryList = await entries.list(entryPermit(), {
      limit: 50,
      offset: 0,
      filter: {
        voucherNo: { kind: 'text', op: 'eq', value: journal.voucherNo },
      },
    })
    expect(entryList.count).toBe(2)
    for (const e of entryList.results) {
      cleanupIds.entries.push(e.id)
      expect(e.voucherType).toBe('acc.gl_journal')
      expect(e.voucherId).toBe(journal.id)
      expect(e.isCancelled).toBe(false)
      expect(e.isReversed).toBe(false)
      expect(e.isReversal).toBe(false)
    }
    const partyEntry = entryList.results.find((e) => e.partyId === fx.customerId)
    expect(partyEntry?.partyType).toBe('CUSTOMER')
    expect(entryList.results[0]!.seq).toBeLessThan(entryList.results[1]!.seq)

    const report = await entries.report(entryPermit(), { companyId: fx.companyId, asOf: '2026-07-31' })
    expect(report.asOf).toBe('2026-07-31')
    expect(report.roleAccounts.receivable?.some((a) => a.id === fx.receivableId)).toBe(true)
    const row = report.rows.find((r) => r.partyId === fx.customerId)
    expect(row).toBeDefined()
    expect(row!.partyType).toBe('CUSTOMER')
    expect(Number(row!.balances.receivable)).toBe(125.5)
    expect(Number(row!.netReceivable)).toBe(125.5)
    expect(typeof row!.balances.receivable).toBe('string')

    // 已审核不可再改头/行
    await expect(
      journals.update(journalPermit(), journal.id, { remarks: 'x', remarksPresent: true }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      journals.createLine(linePermit(), {
        journalId: journal.id,
        idx: 3,
        accountId: fx.cashId,
        debit: '0',
        credit: '0',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const cancelled = await journals.cancel(journalPermit(), journal.id)
    expect(cancelled.status).toBe('CANCELLED')

    const cancelledEntries = await entries.list(entryPermit(), {
      limit: 50,
      offset: 0,
      filter: {
        voucherNo: { kind: 'text', op: 'eq', value: journal.voucherNo },
      },
    })
    expect(cancelledEntries.count).toBe(2)
    expect(cancelledEntries.results.every((e) => e.isCancelled)).toBe(true)

    const reportAfter = await entries.report(entryPermit(), {
      companyId: fx.companyId,
      asOf: '2026-07-31',
    })
    expect(reportAfter.rows.some((r) => r.partyId === fx.customerId)).toBe(false)

    // 取消后为终态
    await expect(journals.cancel(journalPermit(), journal.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(journals.audit(journalPermit(), journal.id, date)).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  test('仅草稿可删；删除头 cascade 行且不伪造行 destroy 审计', async () => {
    const fx = await seedFixture()
    const journal = await journals.create(journalPermit(), {
      date: '2026-07-26',
      companyId: fx.companyId,
    })
    cleanupIds.journals.push(journal.id)
    const line = await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 1,
      accountId: fx.cashId,
      debit: '0',
      credit: '0',
    })
    cleanupIds.lines.push(line.id)

    await journals.remove(journalPermit(), journal.id)
    cleanupIds.journals = cleanupIds.journals.filter((id) => id !== journal.id)

    await expect(journals.getLine(linePermit(), line.id)).rejects.toMatchObject({ code: 'not_found' })

    const fakeDestroy = await db
      .selectFrom('sys_audit_log')
      .select('id')
      .where('resource', '=', 'acc_gl_journal_line')
      .where('record_id', '=', line.id)
      .where('action_name', '=', 'destroy')
      .executeTakeFirst()
    expect(fakeDestroy).toBeUndefined()
  })

  test('审核无过账日期 → validation；配平失败 → 引擎 validation', async () => {
    const fx = await seedFixture()
    const journal = await journals.create(journalPermit(), {
      date: '2026-07-26',
      companyId: fx.companyId,
    })
    cleanupIds.journals.push(journal.id)
    await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 1,
      accountId: fx.cashId,
      debit: '10',
      credit: '0',
    })
    await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 2,
      accountId: fx.cashId,
      debit: '0',
      credit: '5',
    })

    await expect(journals.audit(journalPermit(), journal.id, null)).rejects.toMatchObject({
      code: 'validation',
    })
    await expect(journals.audit(journalPermit(), journal.id, '2026-07-26')).rejects.toMatchObject({
      code: 'validation',
    })
  })

  test('红冲：引擎 reverse 取负对冲 + is_reversed；重复红冲 conflict', async () => {
    const fx = await seedFixture()
    const journal = await journals.create(journalPermit(), {
      date: '2026-07-26',
      companyId: fx.companyId,
    })
    cleanupIds.journals.push(journal.id)
    await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 1,
      accountId: fx.receivableId,
      debit: '80',
      credit: '0',
      partyType: 'CUSTOMER',
      partyId: fx.customerId,
    })
    await journals.createLine(linePermit(), {
      journalId: journal.id,
      idx: 2,
      accountId: fx.cashId,
      debit: '0',
      credit: '80',
    })
    await journals.audit(journalPermit(), journal.id, '2026-07-26')

    await withTx(db, async (trx) => {
      await gl.reverse(trx, { type: 'acc.gl_journal', id: journal.id }, '2026-07-28')
    })

    const listed = await entries.list(entryPermit(), {
      limit: 50,
      offset: 0,
      filter: {
        voucherNo: { kind: 'text', op: 'eq', value: journal.voucherNo },
      },
    })
    // 原 2 行 + 红字 2 行
    expect(listed.count).toBe(4)
    const originals = listed.results.filter((e) => !e.isReversal)
    const reds = listed.results.filter((e) => e.isReversal)
    expect(originals).toHaveLength(2)
    expect(reds).toHaveLength(2)
    expect(originals.every((e) => e.isReversed)).toBe(true)
    expect(reds.every((e) => !e.isReversed && e.isReversal)).toBe(true)
    // 红字金额取负
    for (const red of reds) {
      expect(Number(red.debit) <= 0).toBe(true)
      expect(Number(red.credit) <= 0).toBe(true)
    }

    // 重复红冲 conflict
    await expect(
      withTx(db, async (trx) => {
        await gl.reverse(trx, { type: 'acc.gl_journal', id: journal.id }, '2026-07-29')
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 红冲后轧差归零，报表不再出现该客户净额（若仅本凭证贡献）
    const report = await entries.report(entryPermit(), {
      companyId: fx.companyId,
      asOf: '2026-07-31',
    })
    const row = report.rows.find((r) => r.partyId === fx.customerId)
    if (row) {
      expect(Number(row.balances.receivable)).toBe(0)
      expect(Number(row.netReceivable)).toBe(0)
    }
  })
})
