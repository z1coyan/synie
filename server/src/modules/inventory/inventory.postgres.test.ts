/**
 * 库存域 PG 集成：状态机/过账/负库存/快照（门控 SYNIE_TEST_DATABASE_URL）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createNumberingService } from '~/platform/numbering/index.ts'
import { createCompanyService } from '../base/company-service.ts'
import { createInventoryServices } from './index.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

function lettersFrom(seed: string, n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < n; i++) {
    const ch = seed[i % seed.length] ?? 'a'
    out += alphabet[ch.charCodeAt(0) % 26]!
  }
  return out
}

run('PG 集成（库存单据状态机与引擎）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db)
  const companies = createCompanyService(db)
  const inv = createInventoryServices(db, numbering)
  let actor: Actor = {
    userId: crypto.randomUUID(),
    username: 'inv-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  const tracked: {
    companyIds: string[]
    categoryIds: string[]
    materialIds: string[]
    warehouseIds: string[]
    docIds: string[]
    transferIds: string[]
    countIds: string[]
    ruleIds: string[]
  } = {
    companyIds: [],
    categoryIds: [],
    materialIds: [],
    warehouseIds: [],
    docIds: [],
    transferIds: [],
    countIds: [],
    ruleIds: [],
  }

  afterAll(async () => {
    const ids = [
      ...tracked.docIds,
      ...tracked.transferIds,
      ...tracked.countIds,
      ...tracked.materialIds,
      ...tracked.warehouseIds,
      ...tracked.categoryIds,
      ...tracked.companyIds,
    ]
    if (ids.length > 0) {
      await db.deleteFrom('sys_audit_log').where('record_id', 'in', ids).execute()
      await db.deleteFrom('inv_stock_entry').where('voucher_id', 'in', ids).execute()
      if (tracked.countIds.length) {
        await db.deleteFrom('inv_stock_count').where('id', 'in', tracked.countIds).execute()
      }
      if (tracked.transferIds.length) {
        await db.deleteFrom('inv_stock_transfer').where('id', 'in', tracked.transferIds).execute()
      }
      if (tracked.docIds.length) {
        await db.deleteFrom('inv_stock_doc').where('id', 'in', tracked.docIds).execute()
      }
      if (tracked.materialIds.length) {
        await db.deleteFrom('inv_material_unit').where('material_id', 'in', tracked.materialIds).execute()
        await db.deleteFrom('inv_material').where('id', 'in', tracked.materialIds).execute()
      }
      if (tracked.warehouseIds.length) {
        await db.deleteFrom('inv_warehouse').where('id', 'in', tracked.warehouseIds).execute()
      }
      // 公司种子仓一并清
      for (const cid of tracked.companyIds) {
        await db.deleteFrom('sys_audit_log').where('company_id', '=', cid).execute()
        await db.deleteFrom('inv_warehouse').where('company_id', '=', cid).execute()
        await db.deleteFrom('bas_company').where('id', '=', cid).execute()
      }
      if (tracked.categoryIds.length) {
        await db.deleteFrom('inv_material_category').where('id', 'in', tracked.categoryIds).execute()
      }
    }
    for (const id of tracked.ruleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await db.destroy()
  })

  test('出入库审核/作废 + 调拨发货收货 + 盘点 + 余额', async () => {
    const admin = await db
      .selectFrom('sys_user')
      .select(['id', 'username'])
      .orderBy('inserted_at', 'asc')
      .executeTakeFirstOrThrow()
    actor = {
      ...actor,
      userId: admin.id,
      username: admin.username,
    }
    const currency = await db
      .selectFrom('bas_currency')
      .select('id')
      .where('iso_code', '=', 'CNY')
      .executeTakeFirstOrThrow()
    const company = await companies.create(actor, {
      code: lettersFrom(suffix, 2),
      name: `库存测公司${suffix}`,
      shortName: `测${suffix.slice(0, 2)}`,
      baseCurrencyId: currency.id,
    })
    tracked.companyIds.push(company.id)
    const units = await db
      .selectFrom('bas_unit')
      .select('id')
      .orderBy('is_base', 'desc')
      .orderBy('inserted_at', 'asc')
      .limit(2)
      .execute()
    expect(units.length).toBeGreaterThanOrEqual(1)
    const unitId = units[0]!.id

    const rule = await numbering.create(actor, {
      resource: 'inv.material',
      name: `T${suffix}物料`,
      segments: [
        { type: 'text', value: `T${suffix}M-` },
        { type: 'seq', padding: 3 },
      ],
      perCompany: false,
      enabled: true,
    })
    tracked.ruleIds.push(rule.id)

    const cat = await inv.categories.create(actor, {
      code: `T${suffix}C`,
      name: `分类${suffix}`,
      isLeaf: true,
    })
    tracked.categoryIds.push(cat.id)

    const mat = await inv.materials.create(actor, {
      name: `物料${suffix}`,
      categoryId: cat.id,
      defaultUnitId: unitId,
    })
    tracked.materialIds.push(mat.id)
    expect(mat.code).toBe(`T${suffix}M-001`)

    const warehouses = []
    for (const label of ['出', '入', '途']) {
      const w = await inv.warehouses.create(actor, {
        name: `T${suffix}${label}`,
        companyId: company.id,
        isLeaf: true,
      })
      tracked.warehouseIds.push(w.id)
      warehouses.push(w)
    }
    const [fromWh, toWh, transitWh] = warehouses

    // 入库 10
    const inbound = await inv.stockDocs.create(actor, {
      docNo: `T${suffix}-IN`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: fromWh!.id,
      summary: '测试入库',
    })
    tracked.docIds.push(inbound.id)
    expect(inbound.status).toBe('DRAFT')
    const line = await inv.stockDocs.createItem(actor, {
      stockDocId: inbound.id,
      idx: 1,
      qty: '10',
      materialId: mat.id,
      unitId,
    })
    expect(line.baseQty).toBe('10')
    const audited = await inv.stockDocs.audit(actor, inbound.id)
    expect(audited.status).toBe('AUDITED')

    // 调拨 4
    const transfer = await inv.stockTransfers.create(actor, {
      docNo: `T${suffix}-TR`,
      companyId: company.id,
      fromWarehouseId: fromWh!.id,
      toWarehouseId: toWh!.id,
      transitWarehouseId: transitWh!.id,
    })
    tracked.transferIds.push(transfer.id)
    const tItem = await inv.stockTransfers.createItem(actor, {
      stockTransferId: transfer.id,
      idx: 1,
      qty: '4',
      materialId: mat.id,
      unitId,
    })
    const shipped = await inv.stockTransfers.ship(actor, transfer.id)
    expect(shipped.status).toBe('SHIPPED')
    const received = await inv.stockTransfers.receive(actor, transfer.id, {})
    expect(received.status).toBe('RECEIVED')
    const tLine = await inv.stockTransfers.getItem(actor, tItem.id)
    expect(tLine.receivedQty).toBe('4')

    // 盘点：调入仓账面 4，实盘 5
    const count = await inv.stockCounts.create(actor, {
      docNo: `T${suffix}-CT`,
      companyId: company.id,
      warehouseId: toWh!.id,
      items: [{ materialId: mat.id, unitId, countedQuantity: '5' }],
    })
    tracked.countIds.push(count.id)
    const countItems = await inv.stockCounts.queryItems(actor, {
      limit: 20,
      offset: 0,
      filter: {
        countId: { kind: 'fk', op: 'in', values: [count.id], labels: [] },
      },
    })
    expect(countItems.count).toBe(1)
    expect(countItems.results[0]!.bookQuantity).toBe('4')
    expect(countItems.results[0]!.countedQuantity).toBe('5')

    await inv.stockCounts.refresh(actor, count.id)
    const approved = await inv.stockCounts.approve(actor, count.id)
    expect(approved.status).toBe('AUDITED')

    const balance = await inv.stockEntries.balance(actor, {
      companyId: company.id,
      materialId: mat.id,
      hideZero: false,
    })
    const byWh = Object.fromEntries(balance.map((r) => [r.warehouseId, r.quantity]))
    expect(byWh[fromWh!.id]).toBe('6')
    expect(byWh[toWh!.id]).toBe('5')
    expect(byWh[transitWh!.id]).toBe('0')

    const cancelled = await inv.stockCounts.cancel(actor, count.id)
    expect(cancelled.status).toBe('CANCELLED')

    // 负库存：作废入库会导致出库仓不足
    await expect(inv.stockDocs.void(actor, inbound.id)).rejects.toMatchObject({
      code: 'conflict',
    })
  })
})
