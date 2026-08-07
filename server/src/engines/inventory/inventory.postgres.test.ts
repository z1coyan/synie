import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { balance, cancel, createInventoryEngine, post } from './index.ts'
import type { StockLine, StockVoucher } from './types.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（库存引擎不变量）', () => {
  const db = createDb(url!)
  const inv = createInventoryEngine()
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const otherWhId = crypto.randomUUID()
  const groupWhId = crypto.randomUUID()
  const allowNegWhId = crypto.randomUUID()
  const otherCoWhId = crypto.randomUUID()

  async function seed(): Promise<void> {
    await db
      .insertInto('bas_currency')
      .values({
        id: currencyId,
        name: `库存测试币-${suffix}`,
        iso_code: letters(suffix, 3),
        active: true,
      })
      .execute()
    await db
      .insertInto('bas_company')
      .values([
        {
          id: companyId,
          code: `C${letters(suffix, 7)}`,
          name: `库存测试公司-${suffix}`,
          short_name: `库测-${suffix.slice(0, 4)}`,
          base_currency_id: currencyId,
        },
        {
          id: otherCompanyId,
          code: `D${letters(suffix, 7)}`,
          name: `库存他司-${suffix}`,
          short_name: `他司-${suffix.slice(0, 4)}`,
          base_currency_id: currencyId,
        },
      ])
      .execute()
    await db
      .insertInto('bas_unit')
      .values({
        id: unitId,
        unit_type: 'quantity',
        is_base: false,
        name: `库存测试单位-${suffix}`,
        symbol: `u${suffix.slice(0, 6)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `CAT${suffix}`,
        name: `库存测试分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    await db
      .insertInto('inv_material')
      .values({
        id: materialId,
        code: `MAT${suffix}`,
        name: `库存测试物料-${suffix}`,
        category_id: categoryId,
        default_unit_id: unitId,
      })
      .execute()
    await db
      .insertInto('inv_warehouse')
      .values([
        {
          id: warehouseId,
          code: `TW1${suffix}`,
          name: `库存主仓-${suffix}`,
          company_id: companyId,
          is_leaf: true,
          active: true,
          allow_negative: false,
        },
        {
          id: otherWhId,
          code: `TW2${suffix}`,
          name: `库存二仓-${suffix}`,
          company_id: companyId,
          is_leaf: true,
          active: true,
          allow_negative: false,
        },
        {
          id: groupWhId,
          code: `TW3${suffix}`,
          name: `库存汇总仓-${suffix}`,
          company_id: companyId,
          is_leaf: false,
          active: true,
          allow_negative: false,
        },
        {
          id: allowNegWhId,
          code: `TW4${suffix}`,
          name: `允许负库存仓-${suffix}`,
          company_id: companyId,
          is_leaf: true,
          active: true,
          allow_negative: true,
        },
        {
          id: otherCoWhId,
          code: `TW5${suffix}`,
          name: `他司仓-${suffix}`,
          company_id: otherCompanyId,
          is_leaf: true,
          active: true,
          allow_negative: false,
        },
      ])
      .execute()
  }

  async function cleanup(): Promise<void> {
    await db.deleteFrom('inv_stock_entry').where('company_id', 'in', [companyId, otherCompanyId]).execute()
    await db.deleteFrom('inv_warehouse').where('company_id', 'in', [companyId, otherCompanyId]).execute()
    await db.deleteFrom('inv_material').where('id', '=', materialId).execute()
    await db.deleteFrom('inv_material_category').where('id', '=', categoryId).execute()
    await db.deleteFrom('bas_unit').where('id', '=', unitId).execute()
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

  function voucher(overrides: Partial<StockVoucher> = {}): StockVoucher {
    return {
      type: 'inv.stock_doc',
      id: crypto.randomUUID(),
      no: `DOC-${crypto.randomUUID().slice(0, 8)}`,
      companyId,
      postingDate: new Date(Date.UTC(2026, 6, 26)),
      ...overrides,
    }
  }

  async function liveQty(wh: string, mat: string): Promise<string> {
    const row = await sql<{ qty: string }>`
      SELECT COALESCE(sum(quantity), 0)::text AS qty
      FROM inv_stock_entry
      WHERE warehouse_id = ${wh} AND material_id = ${mat} AND is_cancelled = false
    `.execute(db)
    return row.rows[0]!.qty
  }

  async function entryCount(voucherId: string): Promise<number> {
    const row = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM inv_stock_entry WHERE voucher_id = ${voucherId}
    `.execute(db)
    return Number(row.rows[0]!.c)
  }

  async function cancelledCount(voucherId: string): Promise<number> {
    const row = await sql<{ c: string }>`
      SELECT count(*) FILTER (WHERE is_cancelled)::text AS c
      FROM inv_stock_entry WHERE voucher_id = ${voucherId}
    `.execute(db)
    return Number(row.rows[0]!.c)
  }

  test('post 入仓 → 同单再过账二仓（多阶段）→ balance → cancel 幂等', async () => {
    const v = voucher({ type: 'inv.stock_transfer', no: `TX-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, v, [
        { warehouseId, materialId, quantity: '10', direction: 'in' },
      ])
    })
    await withTx(db, async (trx) => {
      await inv.post(trx, v, [
        { warehouseId: otherWhId, materialId, quantity: '2', direction: 'in' },
      ])
    })
    expect(await entryCount(v.id)).toBe(2)

    const rows = await inv.balance(db, {
      companyId,
      asOf: v.postingDate,
      hideZero: false,
    })
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.quantity).sort()).toEqual(['10', '2'].sort())

    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: v.type, id: v.id })
    })
    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: v.type, id: v.id })
    })
    expect(await cancelledCount(v.id)).toBe(2)
    expect(await liveQty(warehouseId, materialId)).toBe('0')
  })

  test('负库存拒绝（出库超出余额）', async () => {
    const seedV = voucher({ no: `SEED-NEG-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, seedV, [{ warehouseId, materialId, quantity: '1', direction: 'in' }])
    })
    const out = voucher({ no: `OUT-NEG-${suffix}` })
    try {
      await withTx(db, async (trx) => {
        await inv.post(trx, out, [{ warehouseId, materialId, quantity: '2', direction: 'out' }])
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('conflict')
      expect((err as ApiError).message).toContain('库存不足')
    }
    // 清理 seed
    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: seedV.type, id: seedV.id })
    })
  })

  test('作废致负拒绝（后有出库占用余额）', async () => {
    const inV = voucher({ no: `IN-CXL-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, inV, [{ warehouseId, materialId, quantity: '5', direction: 'in' }])
    })
    const outV = voucher({ no: `OUT-CXL-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, outV, [{ warehouseId, materialId, quantity: '3', direction: 'out' }])
    })
    // 作废入库会把余额从 2 变为 -3 → 拒绝
    try {
      await withTx(db, async (trx) => {
        await inv.cancel(trx, { type: inV.type, id: inV.id })
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('conflict')
      expect((err as ApiError).message).toContain('库存不足')
    }
    // 先作废出库再作废入库
    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: outV.type, id: outV.id })
    })
    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: inV.type, id: inV.id })
    })
    expect(await liveQty(warehouseId, materialId)).toBe('0')
  })

  test('allow_negative 仓豁免负库存', async () => {
    const out = voucher({ no: `NEG-OK-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, out, [{ warehouseId: allowNegWhId, materialId, quantity: '7', direction: 'out' }])
    })
    expect(await liveQty(allowNegWhId, materialId)).toBe('-7')
    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: out.type, id: out.id })
    })
    expect(await liveQty(allowNegWhId, materialId)).toBe('0')
  })

  test('非叶子仓 / 他司仓 / 物料不存在拒绝', async () => {
    const cases: Array<{ name: string; lines: StockLine[]; field: string; msg: string }> = [
      {
        name: 'group wh',
        lines: [{ warehouseId: groupWhId, materialId, quantity: '1', direction: 'in' }],
        field: 'warehouseId',
        msg: '只有叶子仓库才能发生库存',
      },
      {
        name: 'other company',
        lines: [{ warehouseId: otherCoWhId, materialId, quantity: '1', direction: 'in' }],
        field: 'warehouseId',
        msg: '仓库必须属于单据公司',
      },
      {
        name: 'missing material',
        lines: [{ warehouseId, materialId: crypto.randomUUID(), quantity: '1', direction: 'in' }],
        field: 'materialId',
        msg: '物料不存在',
      },
      {
        name: 'missing warehouse',
        lines: [{ warehouseId: crypto.randomUUID(), materialId, quantity: '1', direction: 'in' }],
        field: 'warehouseId',
        msg: '仓库不存在',
      },
    ]
    for (const tc of cases) {
      try {
        await withTx(db, async (trx) => {
          await post(trx, voucher(), tc.lines)
        })
        expect.unreachable(`expected reject: ${tc.name}`)
      } catch (err) {
        expect((err as ApiError).fields?.[tc.field]?.[0]).toBe(tc.msg)
      }
    }
  })

  test('并发出库按（仓×物料）锁串行：仅一笔成功', async () => {
    const seedV = voucher({ no: `SEED-CONC-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, seedV, [{ warehouseId, materialId, quantity: '1', direction: 'in' }])
    })

    const results = await Promise.allSettled([
      withTx(db, async (trx) => {
        await inv.post(trx, voucher({ no: `OUT-A-${suffix}` }), [
          { warehouseId, materialId, quantity: '1', direction: 'out' },
        ])
      }),
      withTx(db, async (trx) => {
        await inv.post(trx, voucher({ no: `OUT-B-${suffix}` }), [
          { warehouseId, materialId, quantity: '1', direction: 'out' },
        ])
      }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled').length
    const failures = results.filter((r) => r.status === 'rejected').length
    expect(successes).toBe(1)
    expect(failures).toBe(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(ApiError)
    expect((rejected.reason as ApiError).code).toBe('conflict')

    expect(await liveQty(warehouseId, materialId)).toBe('0')

    // 清理 seed 出库后余额已 0；seed 入仓若仍 live 则作废会致负——先确认出库已耗尽 seed
    // seed 仍 live（+1）+ 成功出库（-1）= 0；作废 seed 会把余额打到 -1（出库仍在）→ 须先作废出库
    // 查所有 live 出库并作废
    const liveOuts = await sql<{ voucher_type: string; voucher_id: string }>`
      SELECT DISTINCT voucher_type, voucher_id FROM inv_stock_entry
      WHERE warehouse_id = ${warehouseId} AND material_id = ${materialId}
        AND is_cancelled = false AND quantity < 0
    `.execute(db)
    for (const row of liveOuts.rows) {
      await withTx(db, async (trx) => {
        await cancel(trx, { type: row.voucher_type, id: row.voucher_id })
      })
    }
    await withTx(db, async (trx) => {
      await cancel(trx, { type: seedV.type, id: seedV.id })
    })
  })

  test('数量十进制精度（6 位档）过账与余额', async () => {
    const v = voucher({ no: `QTY6-${suffix}` })
    await withTx(db, async (trx) => {
      await inv.post(trx, v, [{ warehouseId, materialId, quantity: '0.000001', direction: 'in' }])
    })
    expect(await liveQty(warehouseId, materialId)).toBe('0.000001')
    await withTx(db, async (trx) => {
      await inv.cancel(trx, { type: v.type, id: v.id })
    })
  })
})

function letters(seed: string, n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < n; i++) {
    const ch = seed[i % seed.length] ?? 'a'
    out += alphabet[ch.charCodeAt(0) % 26]!
  }
  return out
}
