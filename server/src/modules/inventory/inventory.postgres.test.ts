/**
 * 库存域 PG 集成：状态机/过账/负库存/快照（门控 SYNIE_TEST_DATABASE_URL）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createCompanyService } from '../base/company-service.ts'
import { createInventoryServices } from './index.ts'
import { testActor } from '~/platform/authz/testing.ts'

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

/** 公司编号恰好两位字母；在共享库上扫占用后取空位，避免 23505 碰撞 */
async function allocCompanyCode(
  db: ReturnType<typeof createDb>,
  preferredSeed: string,
): Promise<string> {
  const taken = new Set(
    (await db.selectFrom('bas_company').select('code').execute()).map((r) => r.code),
  )
  const preferred = lettersFrom(preferredSeed, 2)
  if (!taken.has(preferred)) return preferred
  for (let a = 0; a < 26; a++) {
    for (let b = 0; b < 26; b++) {
      const code = String.fromCharCode(65 + a) + String.fromCharCode(65 + b)
      if (!taken.has(code)) return code
    }
  }
  throw new Error('无可用公司编号')
}

run('PG 集成（库存单据状态机与引擎）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const authz = createAuthzEnforcer(registry)
  const companies = createCompanyService(db, registry)
  const inv = createInventoryServices(db, numbering, registry)
  let actor: Actor = testActor({
    userId: crypto.randomUUID(),
    username: 'inv-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  /**
   * superAdmin 凭证的 rowFilter 恒为全集，本文件只验领域行为（状态机/过账/负库存），
   * 故一张凭证够用；逐动作码门控与公司边界见 test/inventory-authz.integration.test.ts。
   * ensureBaseline 会改写 actor.userId，故每次现取（created_by_id 要落真实用户）。
   */
  const permit = () => {
    const decision = authz.decideFor(actor, 'invStockDocs', 'read')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }
  /** 公司是 global 资源；夹具建公司现取凭证（actor.userId 会被 ensureBaseline 改写） */
  /** 编号规则（global）：夹具建规则现取凭证 */
  const numberingPermit = () => {
    const decision = authz.decideFor(actor, 'sysNumberingRules', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }
  const companyPermit = () => {
    const decision = authz.decideFor(actor, 'basCompanies', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
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
    currencyIds: string[]
    unitIds: string[]
  } = {
    companyIds: [],
    categoryIds: [],
    materialIds: [],
    warehouseIds: [],
    docIds: [],
    transferIds: [],
    countIds: [],
    ruleIds: [],
    currencyIds: [],
    unitIds: [],
  }

  /** 自愈基线：admin / 启用币种 / 至少一单位（setup 截断共享库后可重跑） */
  async function ensureBaseline(): Promise<{ currencyId: string; unitId: string }> {
    let admin = await db
      .selectFrom('sys_user')
      .select(['id', 'username'])
      .orderBy('inserted_at', 'asc')
      .executeTakeFirst()
    if (!admin) {
      const id = crypto.randomUUID()
      await db
        .insertInto('sys_user')
        .values({
          id,
          username: `inv-admin-${suffix.slice(0, 6).toLowerCase()}`,
          name: '库存单测管理员',
          hashed_password: 'not-used',
          super_admin: true,
          all_companies: true,
        })
        .execute()
      admin = { id, username: `inv-admin-${suffix.slice(0, 6).toLowerCase()}` }
    }
    actor = {
      ...actor,
      userId: admin.id,
      username: admin.username,
    }

    // 优先复用已启用币种；否则插入本测专用启用币种
    let currency = await db
      .selectFrom('bas_currency')
      .select('id')
      .where('active', '=', true)
      .orderBy('inserted_at', 'asc')
      .executeTakeFirst()
    if (!currency) {
      const tag = suffix.slice(0, 3)
      currency = await db
        .insertInto('bas_currency')
        .values({
          name: `库存测币-${suffix}`,
          iso_code: tag,
          symbol: '¤',
          active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      tracked.currencyIds.push(currency.id)
    }

    let unit = await db
      .selectFrom('bas_unit')
      .select('id')
      .orderBy('is_base', 'desc')
      .orderBy('inserted_at', 'asc')
      .executeTakeFirst()
    if (!unit) {
      // weight 基单位全局唯一；优先插非基数量单位以免撞 00003 种子
      unit = await db
        .insertInto('bas_unit')
        .values({
          unit_type: 'quantity',
          is_base: true,
          name: `件-${suffix}`,
          symbol: `Q${suffix.slice(0, 4)}`,
          ratio: '1',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      tracked.unitIds.push(unit.id)
    }
    return { currencyId: currency.id, unitId: unit.id }
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
    if (tracked.unitIds.length) {
      await db.deleteFrom('bas_unit').where('id', 'in', tracked.unitIds).execute()
    }
    if (tracked.currencyIds.length) {
      await db.deleteFrom('bas_currency').where('id', 'in', tracked.currencyIds).execute()
    }
    await db.destroy()
  })

  test('出入库审核/作废 + 调拨发货收货 + 盘点 + 余额', async () => {
    const { currencyId, unitId } = await ensureBaseline()
    const company = await companies.create(companyPermit(), {
      code: lettersFrom(suffix, 2),
      name: `库存测公司${suffix}`,
      shortName: `测${suffix.slice(0, 2)}`,
      baseCurrencyId: currencyId,
    })
    tracked.companyIds.push(company.id)

    // 启用规则全局唯一：已有则复用；否则建本测前缀规则（物料号断言依赖此前缀）
    const existingMaterialRule = await db
      .selectFrom('sys_numbering_rule')
      .select(['id', 'enabled'])
      .where('resource', '=', 'base.material')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existingMaterialRule) {
      const rule = await numbering.create(numberingPermit(), {
        resource: 'base.material',
        name: `T${suffix}物料`,
        segments: [
          { type: 'text', value: `T${suffix}M-` },
          { type: 'seq', padding: 3 },
        ],
        perCompany: false,
        enabled: true,
      })
      tracked.ruleIds.push(rule.id)
    }

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
    if (!existingMaterialRule) {
      expect(mat.code).toBe(`T${suffix}M-001`)
    } else {
      expect(mat.code.length).toBeGreaterThan(0)
    }

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
    const inbound = await inv.stockDocs.create(permit(), {
      docNo: `T${suffix}-IN`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: fromWh!.id,
      summary: '测试入库',
    })
    tracked.docIds.push(inbound.id)
    expect(inbound.status).toBe('DRAFT')
    const line = await inv.stockDocs.createItem(permit(), {
      stockDocId: inbound.id,
      idx: 1,
      qty: '10',
      materialId: mat.id,
      unitId,
    })
    expect(line.baseQty).toBe('10')
    const audited = await inv.stockDocs.audit(permit(), inbound.id)
    expect(audited.status).toBe('AUDITED')

    // 调拨 4
    const transfer = await inv.stockTransfers.create(permit(), {
      docNo: `T${suffix}-TR`,
      companyId: company.id,
      fromWarehouseId: fromWh!.id,
      toWarehouseId: toWh!.id,
      transitWarehouseId: transitWh!.id,
    })
    tracked.transferIds.push(transfer.id)
    const tItem = await inv.stockTransfers.createItem(permit(), {
      stockTransferId: transfer.id,
      idx: 1,
      qty: '4',
      materialId: mat.id,
      unitId,
    })
    const shipped = await inv.stockTransfers.ship(permit(), transfer.id)
    expect(shipped.status).toBe('SHIPPED')
    const received = await inv.stockTransfers.receive(permit(), transfer.id, {})
    expect(received.status).toBe('RECEIVED')
    const tLine = await inv.stockTransfers.getItem(permit(), tItem.id)
    expect(tLine.receivedQty).toBe('4')

    // 盘点：调入仓账面 4，实盘 5
    const count = await inv.stockCounts.create(permit(), {
      docNo: `T${suffix}-CT`,
      companyId: company.id,
      warehouseId: toWh!.id,
      items: [{ materialId: mat.id, unitId, countedQuantity: '5' }],
    })
    tracked.countIds.push(count.id)
    const countItems = await inv.stockCounts.queryItems(permit(), {
      limit: 20,
      offset: 0,
      filter: {
        countId: { kind: 'fk', op: 'in', values: [count.id], labels: [] },
      },
    })
    expect(countItems.count).toBe(1)
    expect(countItems.results[0]!.bookQuantity).toBe('4')
    expect(countItems.results[0]!.countedQuantity).toBe('5')

    await inv.stockCounts.refresh(permit(), count.id)
    const approved = await inv.stockCounts.approve(permit(), count.id)
    expect(approved.status).toBe('AUDITED')

    const balance = await inv.stockEntries.balance(permit(), {
      companyId: company.id,
      materialId: mat.id,
      hideZero: false,
    })
    const byWh = Object.fromEntries(balance.map((r) => [r.warehouseId, r.quantity]))
    expect(byWh[fromWh!.id]).toBe('6')
    expect(byWh[toWh!.id]).toBe('5')
    expect(byWh[transitWh!.id]).toBe('0')

    const cancelled = await inv.stockCounts.cancel(permit(), count.id)
    expect(cancelled.status).toBe('CANCELLED')

    // 负库存：作废入库会导致出库仓不足
    await expect(inv.stockDocs.void(permit(), inbound.id)).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  test('状态机：方向锁死/停用仓拦新/已发货不可改删/实收容差/快照兜底', async () => {
    const { currencyId, unitId } = await ensureBaseline()
    const edgeSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
    const company = await companies.create(companyPermit(), {
      code: lettersFrom(edgeSuffix, 2),
      name: `边界测公司${edgeSuffix}`,
      shortName: `边${edgeSuffix.slice(0, 2)}`,
      baseCurrencyId: currencyId,
    })
    tracked.companyIds.push(company.id)

    // 物料编号规则：若前测已建启用规则则复用
    const existingRule = await db
      .selectFrom('sys_numbering_rule')
      .select('id')
      .where('resource', '=', 'base.material')
      .where('enabled', '=', true)
      .executeTakeFirst()
    if (!existingRule) {
      const rule = await numbering.create(numberingPermit(), {
        resource: 'base.material',
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
    const draft = await inv.stockDocs.create(permit(), {
      docNo: `B${edgeSuffix}-DIR`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: whA.id,
    })
    tracked.docIds.push(draft.id)
    await expect(
      inv.stockDocs.update(permit(), draft.id, { direction: 'OUT' }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 停用仓拦新
    await expect(
      inv.stockDocs.create(permit(), {
        docNo: `B${edgeSuffix}-OFF`,
        direction: 'IN',
        companyId: company.id,
        warehouseId: whOff.id,
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 建库存：入库 8 到 A
    await inv.stockDocs.createItem(permit(), {
      stockDocId: draft.id,
      idx: 1,
      qty: '8',
      materialId: mat.id,
      unitId,
    })
    await inv.stockDocs.audit(permit(), draft.id)

    // 调拨 5：部分收货 3 → 在途留 2
    const tr = await inv.stockTransfers.create(permit(), {
      docNo: `B${edgeSuffix}-TR`,
      companyId: company.id,
      fromWarehouseId: whA.id,
      toWarehouseId: whB.id,
      transitWarehouseId: whT.id,
    })
    tracked.transferIds.push(tr.id)
    const ti = await inv.stockTransfers.createItem(permit(), {
      stockTransferId: tr.id,
      idx: 1,
      qty: '5',
      materialId: mat.id,
      unitId,
    })
    await inv.stockTransfers.ship(permit(), tr.id)

    // 已发货不可改删
    await expect(inv.stockTransfers.update(permit(), tr.id, { summary: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(inv.stockTransfers.remove(permit(), tr.id)).rejects.toMatchObject({ code: 'conflict' })

    // 实收 > 已发 拒绝
    await expect(
      inv.stockTransfers.receive(permit(), tr.id, {
        receipts: [{ itemId: ti.id, qty: '9' }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    // 部分收货
    await inv.stockTransfers.receive(permit(), tr.id, {
      receipts: [{ itemId: ti.id, qty: '3' }],
    })
    const bal = await inv.stockEntries.balance(permit(), {
      companyId: company.id,
      materialId: mat.id,
      hideZero: false,
    })
    const byWh = Object.fromEntries(bal.map((r) => [r.warehouseId, r.quantity]))
    expect(byWh[whA.id]).toBe('3') // 8-5
    expect(byWh[whT.id]).toBe('2') // 5-3
    expect(byWh[whB.id]).toBe('3')

    // 快照兜底：开盘点后若再动库存则审核拒
    const ct = await inv.stockCounts.create(permit(), {
      docNo: `B${edgeSuffix}-CT`,
      companyId: company.id,
      warehouseId: whB.id,
      items: [{ materialId: mat.id, unitId, countedQuantity: '3' }],
    })
    tracked.countIds.push(ct.id)
    // 再入一笔到 B，使快照过期
    const late = await inv.stockDocs.create(permit(), {
      docNo: `B${edgeSuffix}-LATE`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: whB.id,
    })
    tracked.docIds.push(late.id)
    await inv.stockDocs.createItem(permit(), {
      stockDocId: late.id,
      idx: 1,
      qty: '1',
      materialId: mat.id,
      unitId,
    })
    await inv.stockDocs.audit(permit(), late.id)

    await expect(inv.stockCounts.approve(permit(), ct.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    // 刷新后可过
    await inv.stockCounts.refresh(permit(), ct.id)
    // 刷新后账面 4，实盘仍是 3 → 差异 -1
    const afterRefresh = await inv.stockCounts.queryItems(permit(), {
      limit: 10,
      offset: 0,
      filter: {
        countId: { kind: 'fk', op: 'in', values: [ct.id], labels: [] },
      },
    })
    expect(afterRefresh.results[0]!.bookQuantity).toBe('4')
    const appr = await inv.stockCounts.approve(permit(), ct.id)
    expect(appr.status).toBe('AUDITED')
  })

  test('物料类型准入：非库存类物料不可进手工出入库/调拨/盘点行', async () => {
    const { currencyId, unitId } = await ensureBaseline()
    const typeSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()
    const company = await companies.create(companyPermit(), {
      code: await allocCompanyCode(db, `T${typeSuffix}`),
      name: `类型测公司${typeSuffix}`,
      shortName: `类${typeSuffix.slice(0, 2)}`,
      baseCurrencyId: currencyId,
    })
    tracked.companyIds.push(company.id)

    const cat = await inv.categories.create(actor, {
      code: `TC${typeSuffix}`,
      name: `类型分类${typeSuffix}`,
      isLeaf: true,
    })
    tracked.categoryIds.push(cat.id)
    const virtualMat = await inv.materials.create(actor, {
      name: `虚拟料${typeSuffix}`,
      categoryId: cat.id,
      defaultUnitId: unitId,
      materialType: 'VIRTUAL',
    })
    const assetMat = await inv.materials.create(actor, {
      name: `资产料${typeSuffix}`,
      categoryId: cat.id,
      defaultUnitId: unitId,
      materialType: 'ASSET',
    })
    tracked.materialIds.push(virtualMat.id, assetMat.id)

    const wh = await inv.warehouses.create(actor, {
      name: `类型仓${typeSuffix}`,
      companyId: company.id,
      isLeaf: true,
    })
    tracked.warehouseIds.push(wh.id)
    const whB = await inv.warehouses.create(actor, {
      name: `类型仓二${typeSuffix}`,
      companyId: company.id,
      isLeaf: true,
    })
    tracked.warehouseIds.push(whB.id)
    const whT = await inv.warehouses.create(actor, {
      name: `类型仓三${typeSuffix}`,
      companyId: company.id,
      isLeaf: true,
    })
    tracked.warehouseIds.push(whT.id)

    // 手工出入库行拦 VIRTUAL/ASSET
    const doc = await inv.stockDocs.create(permit(), {
      docNo: `T${typeSuffix}-IN`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: wh.id,
    })
    tracked.docIds.push(doc.id)
    await expect(
      inv.stockDocs.createItem(permit(), {
        stockDocId: doc.id,
        idx: 1,
        qty: '1',
        materialId: virtualMat.id,
        unitId,
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进库存单据'] },
    })
    await expect(
      inv.stockDocs.createItem(permit(), {
        stockDocId: doc.id,
        idx: 1,
        qty: '1',
        materialId: assetMat.id,
        unitId,
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进库存单据'] },
    })

    // 手工调拨行拦
    const transfer = await inv.stockTransfers.create(permit(), {
      docNo: `T${typeSuffix}-TR`,
      companyId: company.id,
      fromWarehouseId: wh.id,
      toWarehouseId: whB.id,
      transitWarehouseId: whT.id,
    })
    tracked.transferIds.push(transfer.id)
    await expect(
      inv.stockTransfers.createItem(permit(), {
        stockTransferId: transfer.id,
        idx: 1,
        qty: '1',
        materialId: virtualMat.id,
        unitId,
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进库存单据'] },
    })

    // 盘点行拦（实盘与账面两条路径共用同一折算校验）
    await expect(
      inv.stockCounts.create(permit(), {
        docNo: `T${typeSuffix}-CT`,
        companyId: company.id,
        warehouseId: wh.id,
        items: [{ materialId: assetMat.id, unitId, countedQuantity: '1' }],
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进库存单据'] },
    })
    await expect(
      inv.stockCounts.create(permit(), {
        docNo: `T${typeSuffix}-CT2`,
        companyId: company.id,
        warehouseId: wh.id,
        items: [{ materialId: virtualMat.id, unitId }],
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进库存单据'] },
    })
  })

  test('物料类型：默认库存、枚举校验、有库存分录后锁定', async () => {
    const { currencyId, unitId } = await ensureBaseline()
    const lockSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()
    const company = await companies.create(companyPermit(), {
      code: await allocCompanyCode(db, `L${lockSuffix}`),
      name: `类型锁公司${lockSuffix}`,
      shortName: `锁${lockSuffix.slice(0, 2)}`,
      baseCurrencyId: currencyId,
    })
    tracked.companyIds.push(company.id)

    const cat = await inv.categories.create(actor, {
      code: `LC${lockSuffix}`,
      name: `类型锁分类${lockSuffix}`,
      isLeaf: true,
    })
    tracked.categoryIds.push(cat.id)

    // 不传类型默认 STOCK
    const mat = await inv.materials.create(actor, {
      name: `默认料${lockSuffix}`,
      categoryId: cat.id,
      defaultUnitId: unitId,
    })
    tracked.materialIds.push(mat.id)
    expect(mat.materialType).toBe('STOCK')

    // 非法枚举值拒绝
    await expect(
      inv.materials.create(actor, {
        name: `非法料${lockSuffix}`,
        categoryId: cat.id,
        defaultUnitId: unitId,
        materialType: 'FOO',
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    // 无库存分录时类型可改
    const changed = await inv.materials.update(actor, mat.id, { materialType: 'VIRTUAL' })
    expect(changed.materialType).toBe('VIRTUAL')
    await inv.materials.update(actor, mat.id, { materialType: 'STOCK' })

    // 审核一笔入库产生库存分录后,类型锁定(含已作废分录)
    const wh = await inv.warehouses.create(actor, {
      name: `类型锁仓${lockSuffix}`,
      companyId: company.id,
      isLeaf: true,
    })
    tracked.warehouseIds.push(wh.id)
    const doc = await inv.stockDocs.create(permit(), {
      docNo: `L${lockSuffix}-IN`,
      direction: 'IN',
      companyId: company.id,
      warehouseId: wh.id,
    })
    tracked.docIds.push(doc.id)
    await inv.stockDocs.createItem(permit(), {
      stockDocId: doc.id,
      idx: 1,
      qty: '1',
      materialId: mat.id,
      unitId,
    })
    await inv.stockDocs.audit(permit(), doc.id)
    await expect(
      inv.materials.update(actor, mat.id, { materialType: 'ASSET' }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  test('仓库 seedDefaults 幂等 + listOutsourced 按协作方过滤', async () => {
    const { currencyId } = await ensureBaseline()
    const seedSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()
    const company = await companies.create(companyPermit(), {
      code: await allocCompanyCode(db, `W${seedSuffix}`),
      name: `仓种子${seedSuffix}`,
      shortName: `仓${seedSuffix.slice(0, 2)}`,
      baseCurrencyId: currencyId,
    })
    const partner = await companies.create(companyPermit(), {
      code: await allocCompanyCode(db, `P${seedSuffix}`),
      name: `协作方${seedSuffix}`,
      shortName: `协${seedSuffix.slice(0, 2)}`,
      baseCurrencyId: currencyId,
    })
    tracked.companyIds.push(company.id, partner.id)

    // create 公司时已种子三仓；再调 seedDefaults 应返回 0
    const again = await inv.warehouses.seedDefaults(actor, company.id)
    expect(again).toBe(0)

    // 协作方不能是本公司；绑定 partner
    const outWh = await inv.warehouses.create(actor, {
      name: `外协仓${seedSuffix}`,
      companyId: company.id,
      isLeaf: true,
      isOutsourced: true,
      partyType: 'COMPANY',
      partyId: partner.id,
    })
    tracked.warehouseIds.push(outWh.id)
    expect(outWh.isOutsourced).toBe(true)

    const hit = await inv.warehouses.listOutsourced(actor, 'COMPANY', partner.id, {
      limit: 50,
      offset: 0,
    })
    expect(hit.results.some((w) => w.id === outWh.id)).toBe(true)

    const miss = await inv.warehouses.listOutsourced(
      actor,
      'COMPANY',
      '00000000-0000-0000-0000-000000000099',
      { limit: 50, offset: 0 },
    )
    expect(miss.count).toBe(0)

    await expect(
      inv.warehouses.listOutsourced(actor, 'CUSTOMER', partner.id, { limit: 10, offset: 0 }),
    ).rejects.toMatchObject({ code: 'validation' })
  })
})
