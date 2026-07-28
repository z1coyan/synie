import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { cancel, createGlEngine, post, reverse } from './index.ts'
import type { GlEntry, GlVoucher } from './types.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（GL 引擎不变量）', () => {
  const db = createDb(url!)
  const gl = createGlEngine()
  const suffix = crypto.randomUUID().replace(/-/g, '').toUpperCase()
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const receivableId = crypto.randomUUID()
  const cashId = crypto.randomUUID()
  const groupId = crypto.randomUUID()
  const inactiveId = crypto.randomUUID()
  const otherCoCashId = crypto.randomUUID()
  const partyType = 'customer'
  const partyId = crypto.randomUUID()

  async function seed(): Promise<void> {
    await db
      .insertInto('bas_currency')
      .values({
        id: currencyId,
        name: `总账测试币-${suffix.slice(0, 8)}`,
        iso_code: suffix.slice(0, 3),
        active: true,
      })
      .execute()
    await db
      .insertInto('bas_company')
      .values({
        id: companyId,
        code: `G${suffix.slice(0, 7)}`,
        name: `总账测试公司-${suffix.slice(0, 8)}`,
        short_name: `总账测-${suffix.slice(0, 4)}`,
        base_currency_id: currencyId,
      })
      .execute()
    await db
      .insertInto('bas_company')
      .values({
        id: otherCompanyId,
        code: `H${suffix.slice(0, 7)}`,
        name: `总账他司-${suffix.slice(0, 8)}`,
        short_name: `他司-${suffix.slice(0, 4)}`,
        base_currency_id: currencyId,
      })
      .execute()
    await db
      .insertInto('bas_account')
      .values([
        {
          id: receivableId,
          code: '1122',
          name: '应收账款',
          direction: 'debit',
          is_group: false,
          active: true,
          role: 'receivable',
          company_id: companyId,
        },
        {
          id: cashId,
          code: '1001',
          name: '库存现金',
          direction: 'debit',
          is_group: false,
          active: true,
          role: null,
          company_id: companyId,
        },
        {
          id: groupId,
          code: '1000',
          name: '资产汇总',
          direction: 'debit',
          is_group: true,
          active: true,
          role: null,
          company_id: companyId,
        },
        {
          id: inactiveId,
          code: '1002',
          name: '停用科目',
          direction: 'debit',
          is_group: false,
          active: false,
          role: null,
          company_id: companyId,
        },
        {
          id: otherCoCashId,
          code: '1001',
          name: '他司现金',
          direction: 'debit',
          is_group: false,
          active: true,
          role: null,
          company_id: otherCompanyId,
        },
      ])
      .execute()
  }

  async function cleanup(): Promise<void> {
    await db.deleteFrom('acc_gl_entry').where('company_id', 'in', [companyId, otherCompanyId]).execute()
    await db.deleteFrom('bas_account').where('company_id', 'in', [companyId, otherCompanyId]).execute()
    await db.deleteFrom('bas_company').where('id', 'in', [companyId, otherCompanyId]).execute()
    await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
  }

  afterAll(async () => {
    try {
      await cleanup()
    } finally {
      await db.destroy()
    }
  })

  test('seed fixture', async () => {
    await seed()
  })

  function balancedEntries(withParty = true): GlEntry[] {
    return [
      {
        accountId: receivableId,
        debit: '100',
        ...(withParty ? { partyType, partyId } : {}),
      },
      { accountId: cashId, credit: '100' },
    ]
  }

  function voucher(overrides: Partial<GlVoucher> = {}): GlVoucher {
    return {
      type: 'acc.gl_journal',
      id: crypto.randomUUID(),
      no: `记-${suffix.slice(0, 12)}`,
      companyId,
      postingDate: new Date(Date.UTC(2026, 6, 26)),
      ...overrides,
    }
  }

  async function factCounts(voucherId: string): Promise<{
    total: number
    reversed: number
    reversal: number
    cancelled: number
  }> {
    const row = await sql<{
      total: string
      reversed: string
      reversal: string
      cancelled: string
    }>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE is_reversed)::text AS reversed,
             count(*) FILTER (WHERE is_reversal)::text AS reversal,
             count(*) FILTER (WHERE is_cancelled)::text AS cancelled
      FROM acc_gl_entry WHERE voucher_id = ${voucherId}
    `.execute(db)
    const r = row.rows[0]!
    return {
      total: Number(r.total),
      reversed: Number(r.reversed),
      reversal: Number(r.reversal),
      cancelled: Number(r.cancelled),
    }
  }

  async function netAmount(voucherId: string): Promise<string> {
    const row = await sql<{ net: string }>`
      SELECT coalesce(sum(debit - credit) FILTER (WHERE is_cancelled = false), 0)::text AS net
      FROM acc_gl_entry WHERE voucher_id = ${voucherId}
    `.execute(db)
    return row.rows[0]!.net
  }

  test('post → reverse 归零 → 重复红冲 conflict → cancel 幂等', async () => {
    const v = voucher()
    await withTx(db, async (trx) => {
      await gl.post(trx, v, balancedEntries())
    })
    expect(await factCounts(v.id)).toEqual({ total: 2, reversed: 0, reversal: 0, cancelled: 0 })

    const reversalDate = new Date(Date.UTC(2026, 6, 31))
    await withTx(db, async (trx) => {
      await gl.reverse(trx, { type: v.type, id: v.id }, reversalDate)
    })
    expect(await factCounts(v.id)).toEqual({ total: 4, reversed: 2, reversal: 2, cancelled: 0 })
    // 红冲后未作废分录净额归零
    expect(await netAmount(v.id)).toBe('0')

    await expect(
      withTx(db, async (trx) => {
        await gl.reverse(trx, { type: v.type, id: v.id }, reversalDate)
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: '该单据没有可红冲的分录' })

    await withTx(db, async (trx) => {
      await gl.cancel(trx, { type: v.type, id: v.id })
    })
    await withTx(db, async (trx) => {
      await gl.cancel(trx, { type: v.type, id: v.id })
    })
    expect(await factCounts(v.id)).toEqual({ total: 4, reversed: 2, reversal: 2, cancelled: 4 })
  })

  test('配平拒绝', async () => {
    const v = voucher()
    try {
      await withTx(db, async (trx) => {
        await post(trx, v, [
          { accountId: receivableId, debit: '100', partyType, partyId },
          { accountId: cashId, credit: '50' },
        ])
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).fields?.entries?.[0]).toBe('借贷不平')
    }
    expect(await factCounts(v.id)).toEqual({ total: 0, reversed: 0, reversal: 0, cancelled: 0 })
  })

  test('往来科目缺对手拒绝', async () => {
    try {
      await withTx(db, async (trx) => {
        await gl.validateEntries(trx, companyId, balancedEntries(false))
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).fields?.entries?.[0]).toContain('必须填写对手')
    }
  })

  test('汇总科目 / 停用科目 / 他司科目拒绝', async () => {
    const cases: Array<{ name: string; entries: GlEntry[]; msg: string }> = [
      {
        name: 'group',
        entries: [
          { accountId: groupId, debit: '10' },
          { accountId: cashId, credit: '10' },
        ],
        msg: '汇总科目不能入账',
      },
      {
        name: 'inactive',
        entries: [
          { accountId: inactiveId, debit: '10' },
          { accountId: cashId, credit: '10' },
        ],
        msg: '停用科目不能入账',
      },
      {
        name: 'other company',
        entries: [
          { accountId: otherCoCashId, debit: '10' },
          { accountId: cashId, credit: '10' },
        ],
        msg: '科目必须属于单据公司',
      },
    ]
    for (const tc of cases) {
      try {
        await withTx(db, async (trx) => {
          await gl.validateEntries(trx, companyId, tc.entries)
        })
        expect.unreachable(`expected reject: ${tc.name}`)
      } catch (err) {
        expect((err as ApiError).fields?.entries?.[0]).toBe(tc.msg)
      }
    }
  })

  test('科目不存在拒绝', async () => {
    try {
      await withTx(db, async (trx) => {
        await gl.validateEntries(trx, companyId, [
          { accountId: crypto.randomUUID(), debit: '10' },
          { accountId: cashId, credit: '10' },
        ])
      })
      expect.unreachable()
    } catch (err) {
      expect((err as ApiError).fields?.entries?.[0]).toBe('科目不存在')
    }
  })

  test('红冲行豁免往来对手；普通行不豁免', async () => {
    // 红字行 isReversal=true 可不带对手（即使科目为往来角色）
    await withTx(db, async (trx) => {
      await gl.validateEntries(
        trx,
        companyId,
        [
          { accountId: receivableId, debit: '-10', isReversal: true },
          { accountId: cashId, credit: '-10', isReversal: true },
        ],
        { allowNegative: true },
      )
    })
  })

  test('cancel 在无分录时仍成功（幂等）', async () => {
    await withTx(db, async (trx) => {
      await cancel(trx, { type: 'acc.gl_journal', id: crypto.randomUUID() })
    })
  })

  test('reverse 无分录 conflict', async () => {
    await expect(
      withTx(db, async (trx) => {
        await reverse(trx, { type: 'acc.gl_journal', id: crypto.randomUUID() }, '2026-07-31')
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: '该单据没有可红冲的分录' })
  })
})
