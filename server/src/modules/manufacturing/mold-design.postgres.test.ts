/**
 * 模具设计 PG 集成：自动建资产物料（1:1）、设置前置、编辑同步、级联删除、权限门控
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createManufacturingServices } from './index.ts'
import { testActor } from '~/platform/authz/testing.ts'

/** 编号规则（global）：夹具建规则现取凭证（superAdmin → rowFilter 全集） */
function numberingPermit(actor: Parameters<typeof numberingAuthz.decideFor>[0]) {
  const decision = numberingAuthz.decideFor(actor, 'sysNumberingRules', 'create')
  if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
  return decision.permit
}
const numberingAuthz = createAuthzEnforcer(createSealedResourceRegistry())

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（模具设计）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const authz = createAuthzEnforcer(registry)
  const mfg = createManufacturingServices(db, numbering, registry)
  /** 模具/物料双资源现取凭证（superAdmin → rowFilter 全集；码级门控见断言用例） */
  const moldPermit = (action: string) => {
    const decision = authz.decideFor(actor, 'mfgMoldDesigns', action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }
  const actor: Actor = testActor({
    userId: '',
    username: 'mold-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const tracked = { materials: [] as string[], designs: [] as string[], ruleIds: [] as string[] }

  async function seed(): Promise<void> {
    await db
      .insertInto('bas_currency')
      .values({
        id: currencyId,
        name: `模具币-${suffix}`,
        iso_code: suffix.slice(0, 3).toUpperCase(),
        active: true,
      })
      .execute()
    await db
      .insertInto('bas_company')
      .values({
        id: companyId,
        code: `D${suffix.slice(0, 7)}`,
        name: `模具公司-${suffix}`,
        short_name: `模-${suffix.slice(0, 4)}`,
        base_currency_id: currencyId,
      })
      .execute()
    await db
      .insertInto('inv_warehouse')
      .values({
        id: warehouseId,
        code: `MD${suffix}`,
        name: `模具仓-${suffix}`,
        company_id: companyId,
        is_leaf: true,
        active: true,
        allow_negative: false,
      })
      .execute()
    await db
      .insertInto('bas_unit')
      .values({
        id: unitId,
        unit_type: 'quantity',
        is_base: false,
        name: `模具单位-${suffix}`,
        symbol: `m${suffix.slice(0, 5)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `E(M)${suffix}`,
        name: `模具分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    // base.material 编号规则：启用规则全局唯一;残留启用规则可能是按公司计数（物料无公司），
    // 统一停用后建本测试的非公司计数规则
    await db
      .updateTable('sys_numbering_rule')
      .set({ enabled: false })
      .where('resource', '=', 'base.material')
      .where('enabled', '=', true)
      .execute()
    const rule = await numbering.create(numberingPermit(actor), {
      resource: 'base.material',
      name: `模具测试物料号-${suffix}`,
      segments: [
        { type: 'text', value: `M${suffix}-` },
        { type: 'seq', padding: 3 },
      ],
      perCompany: false,
      enabled: true,
    })
    tracked.ruleIds.push(rule.id)
  }

  async function setMoldCategory(value: string | null): Promise<void> {
    await db.updateTable('mfg_setting').set({ mold_category_id: value }).execute()
  }

  const seedOnce = seed()

  afterAll(async () => {
    await setMoldCategory(null)
    for (const id of tracked.designs) {
      await db.deleteFrom('mfg_mold_design').where('id', '=', id).execute().catch(() => {})
    }
    for (const id of tracked.materials) {
      await db.deleteFrom('inv_material_unit').where('material_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('inv_stock_entry').where('material_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('inv_material').where('id', '=', id).execute().catch(() => {})
    }
    for (const id of tracked.ruleIds) {
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute().catch(() => {})
    }
    await db.deleteFrom('inv_material_category').where('id', '=', categoryId).execute().catch(() => {})
    await db.deleteFrom('inv_warehouse').where('id', '=', warehouseId).execute().catch(() => {})
    await db.deleteFrom('bas_company').where('id', '=', companyId).execute().catch(() => {})
    await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute().catch(() => {})
    await db.deleteFrom('bas_unit').where('id', '=', unitId).execute().catch(() => {})
    await db.destroy()
  })

  test('未配置模具物料分类时创建报明确错误', async () => {
    await seedOnce
    await setMoldCategory(null)
    await expect(
      mfg.moldDesigns.create(moldPermit('create'), {
        name: `冲孔模-${suffix}`,
        moldType: 'STAMPING',
        unitId,
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: '请先在生产设置中配置模具物料分类' })
  })

  test('创建模具设计：同事务自动建资产物料并 1:1 关联', async () => {
    await seedOnce
    await setMoldCategory(categoryId)
    const design = await mfg.moldDesigns.create(moldPermit('create'), {
      name: `冲孔模-${suffix}`,
      spec: 'Φ12×60',
      moldType: 'STAMPING',
      unitId,
    })
    tracked.designs.push(design.id)
    tracked.materials.push(design.materialId)
    expect(design.moldType).toBe('STAMPING')
    expect(design.materialName).toBe(`冲孔模-${suffix}`)
    expect(design.materialSpec).toBe('Φ12×60')
    expect(design.unitName).toBe(`模具单位-${suffix}`)
    expect(design.materialCode.length).toBeGreaterThan(0)

    const material = await db
      .selectFrom('inv_material')
      .selectAll()
      .where('id', '=', design.materialId)
      .executeTakeFirstOrThrow()
    expect(material.material_type).toBe('ASSET')
    expect(material.category_id).toBe(categoryId)
    expect(material.default_unit_id).toBe(unitId)
    expect(material.active).toBe(true)

    // 枚举校验
    await expect(
      mfg.moldDesigns.create(moldPermit('create'), { name: 'x', moldType: 'FOO', unitId }),
    ).rejects.toMatchObject({ code: 'validation' })
  })

  test('编辑同步物料名称/规格；有转换行时单位不可改', async () => {
    await seedOnce
    await setMoldCategory(categoryId)
    const design = await mfg.moldDesigns.create(moldPermit('create'), {
      name: `弯曲模-${suffix}`,
      moldType: 'FORMING',
      unitId,
    })
    tracked.designs.push(design.id)
    tracked.materials.push(design.materialId)

    const updated = await mfg.moldDesigns.update(moldPermit('update'), design.id, {
      name: `弯曲模改-${suffix}`,
      spec: 'R5',
      specPresent: true,
      moldType: 'POSITIONING',
    })
    expect(updated.materialName).toBe(`弯曲模改-${suffix}`)
    expect(updated.moldType).toBe('POSITIONING')
    const material = await db
      .selectFrom('inv_material')
      .selectAll()
      .where('id', '=', design.materialId)
      .executeTakeFirstOrThrow()
    expect(material.name).toBe(`弯曲模改-${suffix}`)
    expect(material.spec).toBe('R5')

    // 有单位转换行后单位锁定（物料保护先例）
    const unit2 = crypto.randomUUID()
    await db
      .insertInto('bas_unit')
      .values({
        id: unit2,
        unit_type: 'quantity',
        is_base: false,
        name: `副单位-${suffix}`,
        symbol: `s${suffix.slice(0, 5)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_unit')
      .values({ material_id: design.materialId, unit_id: unit2, factor: '2' })
      .execute()
    await expect(
      mfg.moldDesigns.update(moldPermit('update'), design.id, { unitId: unit2 }),
    ).rejects.toMatchObject({ code: 'validation' })
    await db.deleteFrom('bas_unit').where('id', '=', unit2).execute().catch(() => {})
  })

  test('删除级联删物料；有库存分录时拦截', async () => {
    await seedOnce
    await setMoldCategory(categoryId)
    const design = await mfg.moldDesigns.create(moldPermit('create'), {
      name: `定位模-${suffix}`,
      moldType: 'POSITIONING',
      unitId,
    })
    tracked.designs.push(design.id)
    tracked.materials.push(design.materialId)

    // 手工塞一条库存分录（正常路径资产料不会有,验证保护分支）
    await db
      .insertInto('inv_stock_entry')
      .values({
        company_id: companyId,
        warehouse_id: warehouseId,
        material_id: design.materialId,
        quantity: '1',
        voucher_type: 'test',
        voucher_id: crypto.randomUUID(),
        voucher_no: 'T-1',
        posting_date: new Date('2026-08-03T00:00:00Z'),
      })
      .execute()
    await expect(mfg.moldDesigns.remove(moldPermit('delete'), design.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    await db.deleteFrom('inv_stock_entry').where('material_id', '=', design.materialId).execute()

    await mfg.moldDesigns.remove(moldPermit('delete'), design.id)
    const gone = await db
      .selectFrom('inv_material')
      .select('id')
      .where('id', '=', design.materialId)
      .executeTakeFirst()
    expect(gone).toBeUndefined()
    const goneDesign = await db
      .selectFrom('mfg_mold_design')
      .select('id')
      .where('id', '=', design.id)
      .executeTakeFirst()
    expect(goneDesign).toBeUndefined()
  })

  /**
   * 码级门控归 guard（服务层零鉴权代码），故这里断言的是**判定内核**：
   * 缺码 deny（HTTP 上即 403），持码 permit。跨资源写的 allOf 一并验：
   * 只有 mfg.mold_design:create 而没有 base.material:create 时判定 deny——
   * 建模具必然连带建物料，两码缺一不可。
   */
  test('码级门控：缺模具码 deny；缺物料码（跨资源 allOf）同样 deny', async () => {
    await seedOnce
    const materialCreate = `${authz.targetOf('invMaterials').prefix}:create`
    const moldCreate = `${authz.targetOf('mfgMoldDesigns').prefix}:create`
    const none: Actor = testActor({ superAdmin: false, allCompanies: true, permissions: new Set() })
    expect(authz.decideFor(none, 'mfgMoldDesigns', 'create').outcome).toBe('deny')
    expect(authz.decideFor(none, 'mfgMoldDesigns', 'read').outcome).toBe('deny')

    const moldOnly: Actor = testActor({
      superAdmin: false,
      allCompanies: true,
      permissions: new Set([moldCreate]),
    })
    expect(
      authz.decideFor(moldOnly, 'mfgMoldDesigns', 'create', { allOf: [materialCreate] }).outcome,
    ).toBe('deny')

    const both: Actor = testActor({
      superAdmin: false,
      allCompanies: true,
      permissions: new Set([moldCreate, materialCreate]),
    })
    expect(
      authz.decideFor(both, 'mfgMoldDesigns', 'create', { allOf: [materialCreate] }).outcome,
    ).toBe('permit')
  })
})
