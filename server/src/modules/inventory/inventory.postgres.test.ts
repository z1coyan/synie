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

  test('状态机：方向锁死/停用仓拦新/已发货不可改删/实收容差/快照兜底', async () => {
    const admin = await db
      .selectFrom('sys_user')
      .select(['id', 'username'])
      .orderBy('inserted_at', 'asc')
      .executeTakeFirstOrThrow()
    actor = { ...actor, userId: admin.id, username: admin.username }

    const currency = await db
      .selectFrom('bas_currency')
      .select('id')
      .where('iso_code', '=', 'CNY')
      .executeTakeFirstOrThrow()
    const edgeSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
    const company = await companies.create(actor, {
      code: lettersFrom(edgeSuffix, 2),
      name: `边界测公司${edgeSuffix}`,
      shortName: `边${edgeSuffix.slice(0, 2)}`,
      baseCurrencyId: currency.id,
    })
    tracked.companyIds.push(company.id)
    const unitId = (
      await db.selectFrom('bas_unit').select('id').orderBy('is_base', 'desc').executeTakeFirstOrThrow()
    ).id

    // 物料编号规则：若前测已建启用规则则复用
    const existingRule = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'inv.material')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existingRule) {
      const rule = await numbering.create(actor, {
        resource: 'inv.material',
        name: `B${edgeSuffix}物料`,
        segments: [
          { type: 'text', value: `B${edgeSuffix}-` },
          { type: 'seq', padding: 2 },
        ],
        perCompany: false,
        enabled: true,
      })
      tracked.ruleIds.push(rule.id)
    }

    const cat = await inv.categories.create(actor, {
      code: `B${edgeSuffix}C`,
      name: `边界分类${edgeSuffix}`,
      isLeaf: true,
    })
    tracked.categoryIds.push(cat.id)
    const mat = await inv.materials.create(actor, {
      name: `边界料${edgeSuffix}`,
      categoryId: cat.id,
      defaultUnitId: unitId,
    })
    tracked.materialIds.push(mat.id)

    const whA = await inv.warehouses.create(actor, {
      name: `B${edgeSuffix}A`,
      companyId: company.id,
      isLeaf: true,
    })
    const whB = await inv.warehouses.create(actor, {
      name: `B${edgeSuffix}B`,
      companyId: company.id,
      isLeaf: true,
    })
    const whT = await inv.warehouses.create(actor, {
      name: `B${edgeSuffix}T`,
      companyId: company.id,
      isLeaf: true,
    })
    const whOff = await inv.warehouses.create(actor, {
      name: `B${edgeSuffix}停`,
      companyId: company.id,
      isLeaf: true,
      active: false,
    })
    tracked.warehouseIds.push(whA.id, whB.id, whT.id, whOff.id)

    // 方向创建后不可改
    const draft = await inv.stockDocs.create(actor, {
      docNo: `B${edgeSuffix}-DIR`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: whA.id,
    })
    tracked.docIds.push(draft.id)
    await expect(
      inv.stockDocs.update(actor, draft.id, { direction: 'OUT' }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 停用仓拦新
    await expect(
      inv.stockDocs.create(actor, {
        docNo: `B${edgeSuffix}-OFF`,
        direction: 'IN',
        companyId: company.id,
        warehouseId: whOff.id,
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 建库存：入库 8 到 A
    await inv.stockDocs.createItem(actor, {
      stockDocId: draft.id,
      idx: 1,
      qty: '8',
      materialId: mat.id,
      unitId,
    })
    await inv.stockDocs.audit(actor, draft.id)

    // 调拨 5：部分收货 3 → 在途留 2
    const tr = await inv.stockTransfers.create(actor, {
      docNo: `B${edgeSuffix}-TR`,
      companyId: company.id,
      fromWarehouseId: whA.id,
      toWarehouseId: whB.id,
      transitWarehouseId: whT.id,
    })
    tracked.transferIds.push(tr.id)
    const ti = await inv.stockTransfers.createItem(actor, {
      stockTransferId: tr.id,
      idx: 1,
      qty: '5',
      materialId: mat.id,
      unitId,
    })
    await inv.stockTransfers.ship(actor, tr.id)

    // 已发货不可改删
    await expect(inv.stockTransfers.update(actor, tr.id, { summary: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(inv.stockTransfers.remove(actor, tr.id)).rejects.toMatchObject({ code: 'conflict' })

    // 实收 > 已发 拒绝
    await expect(
      inv.stockTransfers.receive(actor, tr.id, {
        receipts: [{ itemId: ti.id, qty: '9' }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 部分收货
    await inv.stockTransfers.receive(actor, tr.id, {
      receipts: [{ itemId: ti.id, qty: '3' }],
    })
    const bal = await inv.stockEntries.balance(actor, {
      companyId: company.id,
      materialId: mat.id,
      hideZero: false,
    })
    const byWh = Object.fromEntries(bal.map((r) => [r.warehouseId, r.quantity]))
    expect(byWh[whA.id]).toBe('3') // 8-5
    expect(byWh[whT.id]).toBe('2') // 5-3
    expect(byWh[whB.id]).toBe('3')

    // 快照兜底：开盘点后若再动库存则审核拒
    const ct = await inv.stockCounts.create(actor, {
      docNo: `B${edgeSuffix}-CT`,
      companyId: company.id,
      warehouseId: whB.id,
      items: [{ materialId: mat.id, unitId, countedQuantity: '3' }],
    })
    tracked.countIds.push(ct.id)
    // 再入一笔到 B，使快照过期
    const late = await inv.stockDocs.create(actor, {
      docNo: `B${edgeSuffix}-LATE`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: whB.id,
    })
    tracked.docIds.push(late.id)
    await inv.stockDocs.createItem(actor, {
      stockDocId: late.id,
      idx: 1,
      qty: '1',
      materialId: mat.id,
      unitId,
    })
    await inv.stockDocs.audit(actor, late.id)

    await expect(inv.stockCounts.approve(actor, ct.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    // 刷新后可过
    await inv.stockCounts.refresh(actor, ct.id)
    // 刷新后账面 4，实盘仍是 3 → 差异 -1
    const afterRefresh = await inv.stockCounts.queryItems(actor, {
      limit: 10,
      offset: 0,
      filter: {
        countId: { kind: 'fk', op: 'in', values: [ct.id], labels: [] },
      },
    })
    expect(afterRefresh.results[0]!.bookQuantity).toBe('4')
    const appr = await inv.stockCounts.approve(actor, ct.id)
    expect(appr.status).toBe('AUDITED')
  })
})
