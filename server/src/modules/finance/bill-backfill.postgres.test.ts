/**
 * 已审核承兑交易补过账：SQL 直插 AUDITED 交易 → backfillPostedGL。
 * 门控 SYNIE_TEST_DATABASE_URL。禁止走 audit（会 replayBill）。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createBillService } from './bill-service.ts'
import * as billReplay from './bill-replay.ts'

const numberingRegistry = createSealedResourceRegistry()
const numberingAuthz = createAuthzEnforcer(numberingRegistry)
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（承兑补过账）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(
    db, buildNumberingCatalog(numberingRegistry), numberingRegistry,
  )
  const gl = createGlEngine()
  const bills = createBillService(db, numbering, { gl, registry: numberingRegistry })

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `BB${suffix}`
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const accountBill = crypto.randomUUID()
  const accountSettle = crypto.randomUUID()
  const accountBank = crypto.randomUUID()
  const accountInterest = crypto.randomUUID()
  const bankAccountId = crypto.randomUUID()
  const toBankAccountId = crypto.randomUUID()
  const userId = crypto.randomUUID()

  const actor: Actor = testActor({
    userId,
    username: 'bb-test',
    name: '承兑补过账测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })

  const permit = (resource = 'accBillTransactions', action = 'audit'): Permit => {
    const decision = numberingAuthz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const today = '2099-07-15'
  const due = '2099-12-31'

  async function insertBill(tag: string): Promise<string> {
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO acc_bill(id, bill_no, bill_kind, due_date, face_amount, transferable)
      VALUES (${id}::uuid, ${prefix + tag}, 'bank_acceptance', ${due}::date, '1000', true)
    `.execute(db)
    return id
  }

  async function insertTx(input: {
    tag: string
    billId: string
    type: string
    party?: boolean
    discount?: { interest: string; net: string }
    toBank?: boolean
    postingDate?: string | null
  }): Promise<string> {
    const id = crypto.randomUUID()
    const partyType = input.party ? 'customer' : null
    const partyId = input.party ? customerId : null
    const interest = input.discount?.interest ?? null
    const net = input.discount?.net ?? null
    const toBank = input.toBank ? toBankAccountId : null
    const posting = input.postingDate === undefined ? today : input.postingDate
    const settleId = input.type === 'reallocate'
      ? null
      : input.discount
        ? accountBank
        : accountSettle
    await sql`
      INSERT INTO acc_bill_transaction(
        id, doc_no, transaction_type, occurred_on, sub_start, sub_end, amount,
        party_type, party_id, discount_org, discount_rate, interest, net_amount,
        posting_date, status, company_id, bank_account_id, to_bank_account_id,
        bill_id, bill_account_id, settle_account_id, interest_account_id)
      VALUES (
        ${id}::uuid, ${prefix + input.tag}, ${input.type}, ${today}::date,
        1, 100000, '1000',
        ${partyType}, ${partyId}::uuid,
        ${input.discount ? '宁波银行' : null},
        ${input.discount ? '1.2' : null},
        ${interest}, ${net},
        ${posting}::date, 'audited', ${companyId}::uuid, ${bankAccountId}::uuid,
        ${toBank}::uuid, ${input.billId}::uuid, ${accountBill}::uuid,
        ${settleId}::uuid,
        ${input.discount ? accountInterest : null}::uuid)
    `.execute(db)
    return id
  }

  async function liveEntries(txId: string) {
    return sql<{
      account_id: string
      debit: string
      credit: string
      party_type: string | null
      party_id: string | null
      is_cancelled: boolean
    }>`
      SELECT account_id, debit::text, credit::text, party_type, party_id, is_cancelled
      FROM acc_gl_entry
      WHERE voucher_type='acc.bill_transaction' AND voucher_id=${txId}::uuid
      ORDER BY seq
    `.execute(db)
  }

  async function backfill(id: string) {
    const spy = spyOn(billReplay, 'replaySegments')
    try {
      const result = await bills.backfillPostedGL(permit(), id)
      expect(spy).not.toHaveBeenCalled()
      return result
    } catch (err) {
      expect(spy).not.toHaveBeenCalled()
      throw err
    } finally {
      spy.mockRestore()
    }
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'B' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'BB', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sys_user(id,username,name,hashed_password)
      VALUES (${userId}::uuid, ${'u' + suffix}, '补过账用户', 'x')
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${accountBill}::uuid, ${'L' + suffix}, ${prefix + '票据'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountSettle}::uuid, ${'S' + suffix}, ${prefix + '结算'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'receivable'),
        (${accountBank}::uuid, ${'K' + suffix}, ${prefix + '银行'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountInterest}::uuid, ${'I' + suffix}, ${prefix + '利息'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    await sql`
      INSERT INTO acc_bank_account(id,alias,bank_name,holder_name,account_no,company_id,currency_id,account_id)
      VALUES
        (${bankAccountId}::uuid, ${prefix + '户'}, '承兑银行', '持有人',
          ${'6222' + suffix.slice(0, 8)}, ${companyId}::uuid, ${currencyId}::uuid, ${accountBill}::uuid),
        (${toBankAccountId}::uuid, ${prefix + '转入'}, '承兑银行', '持有人',
          ${'6333' + suffix.slice(0, 8)}, ${companyId}::uuid, ${currencyId}::uuid, ${accountBill}::uuid)
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bill_holding WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bill_transaction WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bill WHERE bill_no LIKE ${prefix + '%'}`.execute(db)
    await sql`DELETE FROM acc_bank_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_user WHERE id=${userId}::uuid`.execute(db)
    await db.destroy()
  })

  test('RECEIVE 补过账：借票据 / 贷结算(带对手)，且不调用 replayBill', async () => {
    const billId = await insertBill('RECV')
    const txId = await insertTx({ tag: 'RECV', billId, type: 'receive', party: true })
    const out = await backfill(txId)
    expect(out.status).toBe('AUDITED')

    const rows = await liveEntries(txId)
    const live = rows.rows.filter((r) => !r.is_cancelled)
    expect(live).toHaveLength(2)
    expect(live[0]!.account_id).toBe(accountBill)
    expect(Number(live[0]!.debit)).toBe(1000)
    expect(Number(live[0]!.credit)).toBe(0)
    expect(live[0]!.party_id).toBeNull()
    expect(live[1]!.account_id).toBe(accountSettle)
    expect(Number(live[1]!.debit)).toBe(0)
    expect(Number(live[1]!.credit)).toBe(1000)
    expect(live[1]!.party_type).toBe('customer')
    expect(live[1]!.party_id).toBe(customerId)

    const holdings = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM acc_bill_holding WHERE bill_id=${billId}::uuid
    `.execute(db)
    expect(Number(holdings.rows[0]!.c)).toBe(0)
  })

  test('DISCOUNT 含利息补过账为 3 行', async () => {
    const billId = await insertBill('DISC')
    const txId = await insertTx({
      tag: 'DISC', billId, type: 'discount',
      discount: { interest: '10', net: '990' },
    })
    await backfill(txId)
    const live = (await liveEntries(txId)).rows.filter((r) => !r.is_cancelled)
    expect(live).toHaveLength(3)
    expect(live[0]!.account_id).toBe(accountBank)
    expect(Number(live[0]!.debit)).toBe(990)
    expect(live[1]!.account_id).toBe(accountInterest)
    expect(Number(live[1]!.debit)).toBe(10)
    expect(live[2]!.account_id).toBe(accountBill)
    expect(Number(live[2]!.credit)).toBe(1000)
  })

  test('调拨补过账拒绝', async () => {
    const billId = await insertBill('XFER')
    const txId = await insertTx({ tag: 'XFER', billId, type: 'reallocate', toBank: true })
    await expect(backfill(txId)).rejects.toThrow(/调拨/)
    const rows = await liveEntries(txId)
    expect(rows.rows).toHaveLength(0)
  })

  test('第二次调用幂等，分录数不变', async () => {
    const billId = await insertBill('IDEM')
    const txId = await insertTx({ tag: 'IDEM', billId, type: 'receive', party: true })
    await backfill(txId)
    await backfill(txId)
    const live = (await liveEntries(txId)).rows.filter((r) => !r.is_cancelled)
    expect(live).toHaveLength(2)
  })

  test('仅有已作废旧行仍允许补过一组未作废分录', async () => {
    const billId = await insertBill('CANC')
    const txId = await insertTx({ tag: 'CANC', billId, type: 'receive', party: true })
    await sql`
      INSERT INTO acc_gl_entry(
        posting_date,debit,credit,voucher_type,voucher_id,voucher_no,
        company_id,account_id,is_cancelled)
      VALUES
        (${today}::date, 1000, 0, 'acc.bill_transaction', ${txId}::uuid, ${prefix + 'CANC'},
          ${companyId}::uuid, ${accountBill}::uuid, true),
        (${today}::date, 0, 1000, 'acc.bill_transaction', ${txId}::uuid, ${prefix + 'CANC'},
          ${companyId}::uuid, ${accountSettle}::uuid, true)
    `.execute(db)
    await backfill(txId)
    const rows = await liveEntries(txId)
    expect(rows.rows.filter((r) => r.is_cancelled)).toHaveLength(2)
    expect(rows.rows.filter((r) => !r.is_cancelled)).toHaveLength(2)
  })
})
