/**
 * 工单物料需求派生 PG 集成（票 01 派生核心链路 + 票 02 参考库存与净需求默认 + 票 04 作废级联与重复生成）：
 * 理论耗用公式（损耗率空/非空）、按去向拆单分组（多车间+采购混合）、来源互斥、
 * base 复算（转换单位）、快照行归属校验、无快照 422、状态门（完工/作废拒绝）、
 * 编号取号与审计痕；弹窗取数的参考库存（库存引擎按公司全仓聚合，他公司/作废分录不计）、
 * 默认数量=毛−库存（下限 0）与默认去向标记、库存 base→行单位折算、快照脱钩语义；
 * 作废/删除级联物理删派生草稿（写删除审计）、已确认派生单只警告不拦截
 * （confirmed-only 口径：closed/voided 不警告也不删除）、
 * 重复生成警告与 force 重发、改工单数量不回溯已派生草稿、多级递归（派生单→子工单→再派生）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { createManufacturingServices } from './index.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（工单物料需求派生）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const authz = createAuthzEnforcer(registry)
  const mfg = createManufacturingServices(db, numbering, registry)
  const actor: Actor = testActor({
    // 空 userId → 单据 created_by_id 写 null（避免测试环境无 sys_user 行）
    userId: '',
    username: 'mfg-derive-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  // superAdmin 凭证的 rowFilter 恒为全集，本文件只验领域行为
  const permitFor = (resource: string, action: string) => {
    const decision = authz.decideFor(actor, resource, action)
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }
  const permit = permitFor('mfgDemands', 'read')

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const convUnitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const compAId = crypto.randomUUID()
  const compBId = crypto.randomUUID()
  const compCId = crypto.randomUUID()
  const compDId = crypto.randomUUID()
  const deptAId = crypto.randomUUID()
  const deptBId = crypto.randomUUID()
  const deptDisabledId = crypto.randomUUID()
  const deptOtherId = crypto.randomUUID()
  const warehouseAId = crypto.randomUUID()
  const warehouseBId = crypto.randomUUID()
  const otherWarehouseId = crypto.randomUUID()
  /** 本测全部库存分录夹具共用的来源单号（清场按公司删，此 id 仅作标识） */
  const stockVoucherId = crypto.randomUUID()

  const cleanupIds = {
    demands: [] as string[],
    /** 派生草稿单独登记：引用工单（source_work_order_id），必须先于工单与来源需求单清 */
    derivedDemands: [] as string[],
    workOrders: [] as string[],
    boms: [] as string[],
    rules: [] as string[],
  }

  async function seed(): Promise<void> {
    await db
      .insertInto('bas_currency')
      .values({
        id: currencyId,
        name: `派生币-${suffix}`,
        iso_code: suffix.slice(0, 3).toUpperCase(),
        active: true,
      })
      .execute()
    await db
      .insertInto('bas_company')
      .values([
        {
          id: companyId,
          code: `D${suffix.slice(0, 7)}`,
          name: `派生公司-${suffix}`,
          short_name: `派-${suffix.slice(0, 4)}`,
          base_currency_id: currencyId,
        },
        {
          id: otherCompanyId,
          code: `X${suffix.slice(0, 7)}`,
          name: `派生外公司-${suffix}`,
          short_name: `外-${suffix.slice(0, 4)}`,
          base_currency_id: currencyId,
        },
      ])
      .execute()
    await db
      .insertInto('bas_unit')
      .values([
        {
          id: unitId,
          unit_type: 'quantity',
          is_base: false,
          name: `派生单位-${suffix}`,
          symbol: `u${suffix.slice(0, 5)}`,
          ratio: '1',
        },
        {
          id: convUnitId,
          unit_type: 'quantity',
          is_base: false,
          name: `派生转换单位-${suffix}`,
          symbol: `c${suffix.slice(0, 5)}`,
          ratio: '1',
        },
      ])
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `DC${suffix}`,
        name: `派生分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    await db
      .insertInto('inv_material')
      .values([
        { id: materialId, code: `DP${suffix}`, name: `派生成品-${suffix}`, category_id: categoryId, default_unit_id: unitId },
        { id: compAId, code: `DA${suffix}`, name: `嵌件A-${suffix}`, category_id: categoryId, default_unit_id: unitId },
        { id: compBId, code: `DB${suffix}`, name: `材料B-${suffix}`, category_id: categoryId, default_unit_id: unitId },
        { id: compCId, code: `DX${suffix}`, name: `材料C-${suffix}`, category_id: categoryId, default_unit_id: unitId },
        { id: compDId, code: `DD${suffix}`, name: `材料D-${suffix}`, category_id: categoryId, default_unit_id: unitId },
      ])
      .execute()
    // 材料B 的转换单位：1 转换单位 = 1/2 默认单位（deriveItemProjection base=qty/factor）
    await db
      .insertInto('inv_material_unit')
      .values({ material_id: compBId, unit_id: convUnitId, factor: '2' })
      .execute()
    await db
      .insertInto('sys_department')
      .values([
        { id: deptAId, company_id: companyId, code: `DA${suffix.slice(0, 6)}`, name: `车间A-${suffix}`, path: deptAId, enabled: true },
        { id: deptBId, company_id: companyId, code: `DB${suffix.slice(0, 6)}`, name: `车间B-${suffix}`, path: deptBId, enabled: true },
        { id: deptDisabledId, company_id: companyId, code: `DD${suffix.slice(0, 6)}`, name: `停用车间-${suffix}`, path: deptDisabledId, enabled: false },
        { id: deptOtherId, company_id: otherCompanyId, code: `DO${suffix.slice(0, 6)}`, name: `外公司车间-${suffix}`, path: deptOtherId, enabled: true },
      ])
      .execute()
    // 叶子仓（参考库存跨仓合计用）：本司两仓 + 外司一仓
    await db
      .insertInto('inv_warehouse')
      .values([
        { id: warehouseAId, company_id: companyId, code: `WA${suffix.slice(0, 6)}`, name: `派生仓A-${suffix}`, is_leaf: true, active: true, allow_negative: true },
        { id: warehouseBId, company_id: companyId, code: `WB${suffix.slice(0, 6)}`, name: `派生仓B-${suffix}`, is_leaf: true, active: true, allow_negative: true },
        { id: otherWarehouseId, company_id: otherCompanyId, code: `WO${suffix.slice(0, 6)}`, name: `派生外仓-${suffix}`, is_leaf: true, active: true, allow_negative: true },
      ])
      .execute()

    // 派生草稿/工单/BOM 经编号规则取号：已有启用规则则复用，否则建本测前缀规则
    // （共享库并发建撞 one_enabled_per_resource 唯一索引时回落复用）
    async function ensureRule(resource: string, name: string, prefix: string): Promise<void> {
      const existing = await db
        .selectFrom('sys_numbering_rule')
        .select('id')
        .where('resource', '=', resource)
        .where('enabled', '=', true)
        .executeTakeFirst()
      if (existing) return
      try {
        const rule = await numbering.create(permitFor('sysNumberingRules', 'create'), {
          resource,
          name,
          segments: [
            { type: 'text', value: prefix },
            { type: 'seq', padding: 3 },
          ],
          perCompany: false,
          enabled: true,
        })
        cleanupIds.rules.push(rule.id)
      } catch (err) {
        const again = await db
          .selectFrom('sys_numbering_rule')
          .select('id')
          .where('resource', '=', resource)
          .where('enabled', '=', true)
          .executeTakeFirst()
        if (!again) throw err
      }
    }
    await ensureRule('mfg.demand', `T${suffix}需求`, `TD${suffix}-`)
    await ensureRule('mfg.work_order', `T${suffix}工单`, `TW${suffix}-`)
    await ensureRule('mfg.bom', `T${suffix}BOM`, `TB${suffix}-`)
  }

  async function cleanup(): Promise<void> {
    // 逆序清场：派生草稿（引用工单）→ 工单（引用来源需求行）→ 来源需求单
    for (const id of cleanupIds.derivedDemands) {
      await db
        .deleteFrom('sys_attachment')
        .where('owner_type', '=', 'mfg_demand_item')
        .where('owner_id', 'in', (qb) =>
          qb.selectFrom('mfg_demand_item').select('id').where('demand_id', '=', id),
        )
        .execute()
      await db.deleteFrom('mfg_demand_item').where('demand_id', '=', id).execute()
      await db.deleteFrom('mfg_demand').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.workOrders) {
      await db
        .deleteFrom('sys_attachment')
        .where('owner_type', '=', 'mfg_work_order')
        .where('owner_id', '=', id)
        .execute()
      await db.deleteFrom('mfg_work_order').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.demands) {
      await db.deleteFrom('mfg_demand_item').where('demand_id', '=', id).execute()
      await db.deleteFrom('mfg_demand').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.boms) {
      await db.deleteFrom('mfg_bom_component').where('bom_id', '=', id).execute()
      await db.deleteFrom('mfg_bom_route').where('bom_id', '=', id).execute()
      await db.deleteFrom('mfg_bom_byproduct').where('bom_id', '=', id).execute()
      await db.deleteFrom('mfg_bom').where('id', '=', id).execute()
    }
    // 审计行按公司一把清（头/行/动作痕都在本公司下）
    await db.deleteFrom('sys_audit_log').where('company_id', '=', companyId).execute()
    await db.deleteFrom('sys_audit_log').where('company_id', '=', otherCompanyId).execute()
    // 库存分录夹具（先于仓库清）
    await db
      .deleteFrom('inv_stock_entry')
      .where('company_id', 'in', [companyId, otherCompanyId])
      .execute()
    await db
      .deleteFrom('inv_warehouse')
      .where('id', 'in', [warehouseAId, warehouseBId, otherWarehouseId])
      .execute()
    for (const id of cleanupIds.rules) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_numbering_rule').where('id', '=', id).execute()
    }
    await db
      .deleteFrom('sys_department')
      .where('id', 'in', [deptAId, deptBId, deptDisabledId, deptOtherId])
      .execute()
    await db.deleteFrom('inv_material_unit').where('material_id', '=', compBId).execute()
    await db
      .deleteFrom('inv_material')
      .where('id', 'in', [materialId, compAId, compBId, compCId, compDId])
      .execute()
    await db.deleteFrom('inv_material_category').where('id', '=', categoryId).execute()
    await db.deleteFrom('bas_unit').where('id', 'in', [unitId, convUnitId]).execute()
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

  /** 业务单据走服务：需求单(确认) → 工单；bomId 给定时创建即快照（编号一律系统生成） */
  async function makeWorkOrder(opts: { qty: string; bomId?: string }): Promise<{
    id: string
    workOrderNo: string
  }> {
    const demand = await mfg.demands.createDemand(permit, {
      companyId,
      assignType: 'purchase',
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(permit, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '100',
      needDate: '2026-08-01',
    })
    await mfg.demands.confirmDemand(permit, demand.id)
    const wo = await mfg.workOrders.createWorkOrder(permitFor('mfgWorkOrders', 'create'), {
      demandItemId: line.id,
      qty: opts.qty,
      bomId: opts.bomId ?? null,
    })
    cleanupIds.workOrders.push(wo.id)
    return { id: wo.id, workOrderNo: wo.workOrderNo }
  }

  async function makeActiveBom(
    components: Array<{
      materialId: string
      unitId: string
      quantity: string
      lossRate?: string | null
    }>,
    /** BOM 母物料：默认成品；多级递归用例传子物料（嵌件A） */
    bomMaterialId: string = materialId,
  ): Promise<string> {
    const bom = await mfg.master.createBom(permitFor('mfgBoms', 'create'), {
      materialId: bomMaterialId,
      status: 'active',
    })
    cleanupIds.boms.push(bom.id)
    for (const c of components) {
      await mfg.master.createComponent(permitFor('mfgBomComponents', 'update'), {
        bomId: bom.id,
        materialId: c.materialId,
        unitId: c.unitId,
        quantity: c.quantity,
        lossRate: c.lossRate ?? null,
      })
    }
    return bom.id
  }

  test('种子数据', async () => {
    await seed()
  })

  let coreWoId = ''

  test('派生核心：理论耗用公式（损耗率空/非空）+ 按去向拆单 + base 复算 + 头行字段', async () => {
    const bomId = await makeActiveBom([
      { materialId: compAId, unitId, quantity: '2.5', lossRate: '0.05' },
      { materialId: compBId, unitId: convUnitId, quantity: '3' },
      { materialId: compCId, unitId, quantity: '1' },
      { materialId: compCId, unitId, quantity: '0.5' },
    ])
    const wo = await makeWorkOrder({ qty: '40', bomId })
    coreWoId = wo.id
    const snap = await mfg.workOrders.getBomSnapshot(permitFor('mfgWorkOrders', 'read'), wo.id)
    expect(snap.components).toHaveLength(4)
    const [cA, cB, cC, cD] = snap.components as [NonNullable<(typeof snap.components)[number]>, NonNullable<(typeof snap.components)[number]>, NonNullable<(typeof snap.components)[number]>, NonNullable<(typeof snap.components)[number]>]

    const result = await mfg.workOrders.generateMaterialDemand(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
      {
        lines: [
          // 默认数量=毛需求
          { componentId: cA.id, qty: '105', target: { kind: 'dept', deptId: deptAId } },
          // 不设硬顶：允许大于毛需求（120）
          { componentId: cB.id, qty: '150', target: { kind: 'dept', deptId: deptBId } },
          { componentId: cC.id, qty: '40', target: { kind: 'purchase' } },
          // 与 A 同车间 → 合一张草稿
          { componentId: cD.id, qty: '20', target: { kind: 'dept', deptId: deptAId } },
        ],
      },
    )

    // 毛需求回显：净用量 ×(1+损耗率,空按 1)× 工单 base 数量（40）
    const gross = new Map(result.lines.map((l) => [l.componentId, l.grossQty]))
    expect(gross.get(cA.id)).toBe('105') // 2.5 × 1.05 × 40
    expect(gross.get(cB.id)).toBe('120') // 3 × 1 × 40（损耗率空）
    expect(gross.get(cC.id)).toBe('40')
    expect(gross.get(cD.id)).toBe('20')

    // 按去向拆单：车间 A / 车间 B / 采购 各一张草稿
    expect(result.demands).toHaveLength(3)
    const byDept = new Map(result.demands.map((d) => [d.assignedDeptId ?? 'purchase', d]))
    expect(byDept.get(deptAId)).toBeDefined()
    expect(byDept.get(deptBId)).toBeDefined()
    expect(byDept.get('purchase')).toBeDefined()
    for (const d of result.demands) {
      expect(d.demandNo.trim().length).toBeGreaterThan(0)
      cleanupIds.derivedDemands.push(d.id)
    }

    // 头字段：公司=工单公司、业务日期=当天、备注带来源工单号、草稿态
    const heads = await db
      .selectFrom('mfg_demand')
      .selectAll()
      .where('id', 'in', result.demands.map((d) => d.id))
      .execute()
    for (const h of heads) {
      expect(h.company_id).toBe(companyId)
      expect(h.status).toBe('draft')
      expect(h.remarks).toBe(`来源工单:${wo.workOrderNo}`)
    }
    const deptAHead = heads.find((h) => h.id === byDept.get(deptAId)!.id)!
    expect(deptAHead.assigned_dept_id).toBe(deptAId)
    // 指派类型回填：车间向=生产，采购向=采购
    expect(deptAHead.assign_type).toBe('make')
    const purchaseHead = heads.find((h) => h.id === byDept.get('purchase')!.id)!
    expect(purchaseHead.assigned_dept_id).toBeNull()
    expect(purchaseHead.assign_type).toBe('purchase')

    // 行字段：来源工单 / 需求日=工单需求日 / 单位沿用配料行 / base 复算 / 无销售来源
    const items = await db
      .selectFrom('mfg_demand_item')
      .selectAll()
      .where('demand_id', 'in', result.demands.map((d) => d.id))
      .orderBy('demand_id')
      .orderBy('idx')
      .execute()
    expect(items).toHaveLength(4)
    for (const it of items) {
      expect(it.source_work_order_id).toBe(wo.id)
      expect(it.sales_order_item_id).toBeNull()
      expect(it.company_id).toBe(companyId)
      expect(it.status).toBe('pending')
      expect(it.need_date).not.toBeNull()
    }
    const deptAItems = items.filter((i) => i.demand_id === deptAHead.id)
    expect(deptAItems).toHaveLength(2) // 同车间合一张
    const itemA = items.find((i) => i.material_id === compAId)!
    expect(itemA.unit_id).toBe(unitId)
    expect(Number(itemA.base_qty)).toBe(105)
    const itemB = items.find((i) => i.material_id === compBId)!
    expect(itemB.unit_id).toBe(convUnitId) // 单位沿用配料行（转换单位）
    expect(Number(itemB.base_qty)).toBe(75) // base 复算：150 / factor 2
    expect(itemB.unit_name).toBe(`派生转换单位-${suffix}`)

    // 审计痕：派生单创建 + 工单动作（含生成单号清单）
    const demandAudits = await db
      .selectFrom('sys_audit_log')
      .select(['record_id', 'action_name'])
      .where('resource', '=', 'mfg_demand')
      .where('record_id', 'in', result.demands.map((d) => d.id))
      .execute()
    expect(demandAudits.filter((a) => a.action_name === 'create')).toHaveLength(3)
    const actionAudit = await db
      .selectFrom('sys_audit_log')
      .selectAll()
      .where('resource', '=', 'mfg_work_order')
      .where('record_id', '=', wo.id)
      .where('action_name', '=', 'generate_material_demand')
      .executeTakeFirst()
    expect(actionAudit).toBeDefined()
    const changeText = JSON.stringify(actionAudit!.changes)
    for (const d of result.demands) {
      expect(changeText).toContain(d.demandNo)
    }
  })

  test('来源互斥：派生行不可再挂销售来源（销售占用校验不因派生行触发）', async () => {
    const derived = await db
      .selectFrom('mfg_demand_item')
      .select(['id', 'source_work_order_id'])
      .where('source_work_order_id', '=', coreWoId)
      .executeTakeFirstOrThrow()
    await expect(
      mfg.demands.updateDemandItem(permit, derived.id, {
        salesOrderItemId: crypto.randomUUID(),
        salesOrderItemIdPresent: true,
      }),
    ).rejects.toMatchObject({ code: 'validation' })
    // 派生行确认不占销售占用：确认派生草稿不触发销售口径校验（无销售来源即跳过）
    const head = await db
      .selectFrom('mfg_demand_item')
      .select('demand_id')
      .where('id', '=', derived.id)
      .executeTakeFirstOrThrow()
    const confirmed = await mfg.demands.confirmDemand(permit, head.demand_id)
    expect(confirmed.status).toBe('confirmed')
  })

  test('逐项校验：快照行归属 / 停用与跨公司车间 / qty>0；任一失败整体回滚', async () => {
    const bomId = await makeActiveBom([{ materialId: compAId, unitId, quantity: '1' }])
    const woA = await makeWorkOrder({ qty: '10', bomId })
    const woB = await makeWorkOrder({ qty: '10', bomId })
    const snapA = await mfg.workOrders.getBomSnapshot(permitFor('mfgWorkOrders', 'read'), woA.id)
    const snapB = await mfg.workOrders.getBomSnapshot(permitFor('mfgWorkOrders', 'read'), woB.id)
    const derive = (woId: string, lines: Parameters<typeof mfg.workOrders.generateMaterialDemand>[2]['lines']) =>
      mfg.workOrders.generateMaterialDemand(
        permitFor('mfgWorkOrders', 'generate_material_demand'),
        woId,
        { lines },
      )

    // 快照行归属：拿 A 工单的配料行派生 B 工单
    await expect(
      derive(woB.id, [
        { componentId: snapA.components[0]!.id, qty: '1', target: { kind: 'purchase' } },
      ]),
    ).rejects.toMatchObject({ code: 'validation' })

    // 停用车间 / 跨公司车间
    await expect(
      derive(woB.id, [
        { componentId: snapB.components[0]!.id, qty: '1', target: { kind: 'dept', deptId: deptDisabledId } },
      ]),
    ).rejects.toMatchObject({ code: 'validation' })
    await expect(
      derive(woB.id, [
        { componentId: snapB.components[0]!.id, qty: '1', target: { kind: 'dept', deptId: deptOtherId } },
      ]),
    ).rejects.toMatchObject({ code: 'validation' })

    // qty 必须 > 0
    await expect(
      derive(woB.id, [
        { componentId: snapB.components[0]!.id, qty: '0', target: { kind: 'purchase' } },
      ]),
    ).rejects.toMatchObject({ code: 'validation' })

    // 整体回滚：上述失败均未落任何派生草稿
    const leaked = await db
      .selectFrom('mfg_demand_item')
      .select('id')
      .where('source_work_order_id', '=', woB.id)
      .execute()
    expect(leaked).toHaveLength(0)
  })

  test('无 BOM 快照配料行 → 422 明确报错', async () => {
    const wo = await makeWorkOrder({ qty: '10' })
    const result = mfg.workOrders.generateMaterialDemand(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
      { lines: [{ componentId: crypto.randomUUID(), qty: '1', target: { kind: 'purchase' } }] },
    )
    await expect(result).rejects.toMatchObject({
      code: 'unprocessable',
      message: '工单未挂 BOM 快照，无法生成物料需求',
    })
    await expect(result).rejects.toMatchObject({ status: 422 })
  })

  test('状态门：已完工/已作废工单不可执行', async () => {
    const bomId = await makeActiveBom([{ materialId: compAId, unitId, quantity: '1' }])
    const woDone = await makeWorkOrder({ qty: '10', bomId })
    // 完工由生产入库联动；此处直改状态只验动作门
    await sql`UPDATE mfg_work_order SET status = 'completed' WHERE id = ${woDone.id}::uuid`.execute(db)
    const woVoid = await makeWorkOrder({ qty: '10', bomId })
    await mfg.workOrders.voidWorkOrder(permitFor('mfgWorkOrders', 'void'), woVoid.id)

    for (const wo of [woDone, woVoid]) {
      const snap = await mfg.workOrders.getBomSnapshot(permitFor('mfgWorkOrders', 'read'), wo.id)
      await expect(
        mfg.workOrders.generateMaterialDemand(
          permitFor('mfgWorkOrders', 'generate_material_demand'),
          wo.id,
          {
            lines: [
              { componentId: snap.components[0]!.id, qty: '1', target: { kind: 'purchase' } },
            ],
          },
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
    }
  })

  /** 库存分录夹具裸插（参考库存是只读聚合，无需走过账引擎） */
  async function seedStock(
    entries: Array<{
      warehouseId: string
      materialId: string
      qty: string
      companyId?: string
      cancelled?: boolean
    }>,
  ): Promise<void> {
    for (const e of entries) {
      await db
        .insertInto('inv_stock_entry')
        .values({
          company_id: e.companyId ?? companyId,
          warehouse_id: e.warehouseId,
          material_id: e.materialId,
          quantity: e.qty,
          posting_date: new Date('2026-01-01'),
          voucher_type: 'test_fixture',
          voucher_id: stockVoucherId,
          voucher_no: `TS${suffix}`,
          remarks: null,
          is_cancelled: e.cancelled ?? false,
          cancelled_at: e.cancelled ? new Date() : null,
        })
        .execute()
    }
  }

  test('票 02 弹窗取数：无/部分/全覆盖的默认数量与默认去向 + 跨仓合计 + 行单位折算', async () => {
    await seedStock([
      { warehouseId: warehouseAId, materialId: compCId, qty: '30' },
      { warehouseId: warehouseBId, materialId: compCId, qty: '10' },
      // 他公司同物料现货不计入
      { warehouseId: otherWarehouseId, materialId: compCId, companyId: otherCompanyId, qty: '999' },
      // 已作废分录不计入
      { warehouseId: warehouseAId, materialId: compCId, qty: '50', cancelled: true },
      { warehouseId: warehouseAId, materialId: compDId, qty: '45' },
      // 材料B 库存按默认单位记账：base 50
      { warehouseId: warehouseBId, materialId: compBId, qty: '50' },
    ])
    const bomId = await makeActiveBom([
      { materialId: compAId, unitId, quantity: '1' }, // 毛 40，无库存
      { materialId: compCId, unitId, quantity: '2.5' }, // 毛 100，库存跨仓 30+10=40 部分覆盖
      { materialId: compDId, unitId, quantity: '1' }, // 毛 40，库存 45 全覆盖
      { materialId: compBId, unitId: convUnitId, quantity: '3' }, // 毛 120（行单位），库存 base 50
    ])
    const wo = await makeWorkOrder({ qty: '40', bomId })
    const preview = await mfg.workOrders.getMaterialDemandPreview(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
    )
    expect(preview.lines).toHaveLength(4)
    const byMaterial = new Map(preview.lines.map((l) => [l.materialId, l]))

    // 无库存：默认数量=毛需求，需人工选去向
    const a = byMaterial.get(compAId)!
    expect(a.grossQty).toBe('40')
    expect(a.stockQty).toBe('0')
    expect(a.defaultQty).toBe('40')
    expect(a.covered).toBe(false)

    // 部分覆盖：默认=毛−库存；跨仓合计 30+10，他公司 999 与作废 50 不计
    const c = byMaterial.get(compCId)!
    expect(c.grossQty).toBe('100')
    expect(c.stockQty).toBe('40')
    expect(c.defaultQty).toBe('60')
    expect(c.covered).toBe(false)

    // 全覆盖：默认数量下限 0，默认去向「不需要」
    const d = byMaterial.get(compDId)!
    expect(d.grossQty).toBe('40')
    expect(d.stockQty).toBe('45')
    expect(d.defaultQty).toBe('0')
    expect(d.covered).toBe(true)

    // 单位换算：库存 base 单位 → 行单位（1 默认单位 = factor 2 转换单位）
    const b = byMaterial.get(compBId)!
    expect(b.unitId).toBe(convUnitId)
    expect(b.grossQty).toBe('120')
    expect(b.stockQty).toBe('100') // base 50 × factor 2
    expect(b.defaultQty).toBe('20')
    expect(b.covered).toBe(false)
  })

  test('票 02 弹窗取数：无 BOM 快照 → 空行（前端呈现空态）', async () => {
    const wo = await makeWorkOrder({ qty: '10' })
    const preview = await mfg.workOrders.getMaterialDemandPreview(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
    )
    expect(preview.lines).toHaveLength(0)
  })

  test('票 02 快照语义：派生不写库存分录/预留；生成后库存变动不影响已生成草稿', async () => {
    const bomId = await makeActiveBom([{ materialId: compCId, unitId, quantity: '2.5' }])
    const wo = await makeWorkOrder({ qty: '40', bomId })
    const preview = await mfg.workOrders.getMaterialDemandPreview(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
    )
    const line = preview.lines[0]!
    // 承接上一用例的库存快照：毛 100 − 库存 40 = 默认 60
    expect(line.defaultQty).toBe('60')

    const countEntries = async () =>
      Number(
        (
          await sql<{ c: string }>`
            SELECT count(*)::text AS c FROM inv_stock_entry WHERE company_id = ${companyId}
          `.execute(db)
        ).rows[0]?.c ?? 0,
      )
    const before = await countEntries()
    const result = await mfg.workOrders.generateMaterialDemand(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
      {
        lines: [
          { componentId: line.componentId, qty: line.defaultQty, target: { kind: 'dept', deptId: deptAId } },
        ],
      },
    )
    cleanupIds.derivedDemands.push(...result.demands.map((d) => d.id))
    // 派生全程不写任何库存分录（无预留概念）
    expect(await countEntries()).toBe(before)

    // 生成后库存变动不影响已生成草稿（参考库存只是取数瞬间的快照）
    await seedStock([{ warehouseId: warehouseAId, materialId: compCId, qty: '1000' }])
    const items = await db
      .selectFrom('mfg_demand_item')
      .selectAll()
      .where('demand_id', '=', result.demands[0]!.id)
      .execute()
    expect(items).toHaveLength(1)
    expect(Number(items[0]!.qty)).toBe(60)
  })

  /** 票 04 夹具：一行配料一工单，返回工单与快照配料行 */
  async function makeDerivedWorkOrder(qty: string) {
    const bomId = await makeActiveBom([
      { materialId: compAId, unitId, quantity: '1' },
      { materialId: compCId, unitId, quantity: '1' },
    ])
    const wo = await makeWorkOrder({ qty, bomId })
    const snap = await mfg.workOrders.getBomSnapshot(permitFor('mfgWorkOrders', 'read'), wo.id)
    const derive = (lines: Array<{ componentId: string; qty: string; target: { kind: 'dept'; deptId: string } | { kind: 'purchase' } }>, force?: boolean) =>
      mfg.workOrders.generateMaterialDemand(
        permitFor('mfgWorkOrders', 'generate_material_demand'),
        wo.id,
        { lines, force },
      )
    return { wo, snap, derive }
  }

  const derivedItemsOf = (workOrderId: string) =>
    db
      .selectFrom('mfg_demand_item')
      .selectAll()
      .where('source_work_order_id', '=', workOrderId)
      .execute()

  test('票 04 作废级联：派生草稿物理删除（头+行）并写删除审计', async () => {
    const { wo, snap, derive } = await makeDerivedWorkOrder('10')
    const result = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'dept', deptId: deptAId } },
      { componentId: snap.components[1]!.id, qty: '5', target: { kind: 'purchase' } },
    ])
    expect(result.warning).toBeNull()
    expect(result.demands).toHaveLength(2)
    cleanupIds.derivedDemands.push(...result.demands.map((d) => d.id))

    const voided = await mfg.workOrders.voidWorkOrder(permitFor('mfgWorkOrders', 'void'), wo.id)
    expect(voided.workOrder.status).toBe('voided')
    // 无已确认派生单 → 警告名单为空
    expect(voided.confirmedDerivedDemandNos).toEqual([])

    // 头+行均物理删除
    const heads = await db
      .selectFrom('mfg_demand')
      .select('id')
      .where('id', 'in', result.demands.map((d) => d.id))
      .execute()
    expect(heads).toHaveLength(0)
    expect(await derivedItemsOf(wo.id)).toHaveLength(0)

    // 级联删除写删除审计（每张派生草稿一条 destroy）
    const destroyAudits = await db
      .selectFrom('sys_audit_log')
      .select(['record_id', 'action_name'])
      .where('resource', '=', 'mfg_demand')
      .where('record_id', 'in', result.demands.map((d) => d.id))
      .where('action_name', '=', 'destroy')
      .execute()
    expect(destroyAudits).toHaveLength(2)
  })

  test('票 04 作废级联：已确认派生单只警告不拦截，草稿仍被删', async () => {
    const { wo, snap, derive } = await makeDerivedWorkOrder('10')
    const result = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'dept', deptId: deptAId } },
      { componentId: snap.components[1]!.id, qty: '5', target: { kind: 'purchase' } },
    ])
    cleanupIds.derivedDemands.push(...result.demands.map((d) => d.id))
    const confirmedHead = result.demands.find((d) => d.assignedDeptId === deptAId)!
    const draftHead = result.demands.find((d) => d.assignedDeptId === null)!
    await mfg.demands.confirmDemand(permit, confirmedHead.id)

    const voided = await mfg.workOrders.voidWorkOrder(permitFor('mfgWorkOrders', 'void'), wo.id)
    // 作废照常成功，响应带已确认派生单警告名单
    expect(voided.workOrder.status).toBe('voided')
    expect(voided.confirmedDerivedDemandNos).toEqual([confirmedHead.demandNo])

    // 已确认派生单不动；草稿已被级联删除
    const kept = await db
      .selectFrom('mfg_demand')
      .select(['id', 'status'])
      .where('id', '=', confirmedHead.id)
      .executeTakeFirstOrThrow()
    expect(kept.status).toBe('confirmed')
    const draftGone = await db
      .selectFrom('mfg_demand')
      .select('id')
      .where('id', '=', draftHead.id)
      .execute()
    expect(draftGone).toHaveLength(0)
    // 已确认单的需求行保留（仍可追溯来源工单）
    const keptItems = await derivedItemsOf(wo.id)
    expect(keptItems).toHaveLength(1)
    expect(keptItems[0]!.demand_id).toBe(confirmedHead.id)
  })

  test('票 04 删除工单同样级联删派生草稿', async () => {
    const { wo, snap, derive } = await makeDerivedWorkOrder('10')
    const result = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'purchase' } },
    ])
    cleanupIds.derivedDemands.push(...result.demands.map((d) => d.id))

    await mfg.workOrders.deleteWorkOrder(permitFor('mfgWorkOrders', 'delete'), wo.id)

    const heads = await db
      .selectFrom('mfg_demand')
      .select('id')
      .where('id', '=', result.demands[0]!.id)
      .execute()
    expect(heads).toHaveLength(0)
    expect(await derivedItemsOf(wo.id)).toHaveLength(0)
  })

  test('票 04 重复生成：已有派生草稿回警告标记且不生成，force 重发后正常生成', async () => {
    const { wo, snap, derive } = await makeDerivedWorkOrder('10')
    const first = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'purchase' } },
    ])
    expect(first.warning).toBeNull()
    cleanupIds.derivedDemands.push(...first.demands.map((d) => d.id))

    // 再次生成（不带 force）：只回警告，不落新单
    const dup = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'purchase' } },
    ])
    expect(dup.warning).not.toBeNull()
    expect(dup.warning!.existingDraftDemandNos).toEqual([first.demands[0]!.demandNo])
    expect(dup.demands).toHaveLength(0)
    expect(await derivedItemsOf(wo.id)).toHaveLength(1)

    // 二次确认带 force 重发：正常生成，警告为空
    const forced = await derive(
      [{ componentId: snap.components[0]!.id, qty: '10', target: { kind: 'purchase' } }],
      true,
    )
    expect(forced.warning).toBeNull()
    expect(forced.demands).toHaveLength(1)
    cleanupIds.derivedDemands.push(...forced.demands.map((d) => d.id))
    expect(await derivedItemsOf(wo.id)).toHaveLength(2)
  })

  test('票 04 改工单数量不回溯已派生草稿（快照脱钩语义钉死）', async () => {
    const { wo, snap, derive } = await makeDerivedWorkOrder('10')
    const result = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'purchase' } },
    ])
    cleanupIds.derivedDemands.push(...result.demands.map((d) => d.id))

    // 改工单数量（无服务入口，直改库钉语义）：派生草稿不回溯
    await sql`UPDATE mfg_work_order SET qty = '99', base_qty = '99' WHERE id = ${wo.id}::uuid`.execute(db)
    const items = await derivedItemsOf(wo.id)
    expect(items).toHaveLength(1)
    expect(Number(items[0]!.qty)).toBe(10)
    expect(Number(items[0]!.base_qty)).toBe(10)

    // 新取数按新数量算毛需求（99），与已派生草稿（10）互不影响
    const preview = await mfg.workOrders.getMaterialDemandPreview(
      permitFor('mfgWorkOrders', 'generate_material_demand'),
      wo.id,
    )
    expect(preview.lines.find((l) => l.componentId === snap.components[0]!.id)!.grossQty).toBe('99')
  })

  test('票 04 警告名单口径：仅 confirmed 进名单，已作废派生单不警告也不删除', async () => {
    const { wo, snap, derive } = await makeDerivedWorkOrder('10')
    const result = await derive([
      { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'purchase' } },
    ])
    cleanupIds.derivedDemands.push(...result.demands.map((d) => d.id))
    // 派生单走完确认→作废（作废后的派生单既非草稿也非 confirmed）
    const voidedHead = result.demands[0]!
    await mfg.demands.confirmDemand(permit, voidedHead.id)
    await mfg.demands.voidDemand(permit, voidedHead.id)

    const voided = await mfg.workOrders.voidWorkOrder(permitFor('mfgWorkOrders', 'void'), wo.id)
    expect(voided.workOrder.status).toBe('voided')
    // confirmed-only 口径：已作废派生单不进警告名单
    expect(voided.confirmedDerivedDemandNos).toEqual([])

    // 已作废派生单不动（不删除），行仍可追溯来源
    const kept = await db
      .selectFrom('mfg_demand')
      .select(['id', 'status'])
      .where('id', '=', voidedHead.id)
      .executeTakeFirstOrThrow()
    expect(kept.status).toBe('voided')
    expect(await derivedItemsOf(wo.id)).toHaveLength(1)
  })

  test('票 04 多级递归：派生单→子车间开工单→再派生（零专设代码）', async () => {
    // 引用链交叉（一层派生行引用父工单、又被子工单引用），afterAll 统一顺序摆不平，
    // 本用例自清场：二层派生 → 子工单 → 一层派生（父工单与来源需求单仍走 afterAll）
    let childWoId = ''
    let childDemandId = ''
    let secondDemandId = ''
    try {
      // 一层：父工单把嵌件A 派生到车间 A（配料顺序 idx：compA 在前）
      const { wo: parentWo, snap, derive } = await makeDerivedWorkOrder('10')
      const first = await derive([
        { componentId: snap.components[0]!.id, qty: '10', target: { kind: 'dept', deptId: deptAId } },
      ])
      expect(first.demands).toHaveLength(1)
      const childDemand = first.demands[0]!
      childDemandId = childDemand.id
      expect(childDemand.assignedDeptId).toBe(deptAId)
      await mfg.demands.confirmDemand(permit, childDemand.id)

      // 子车间：按派生需求行开自己的工单（物料=嵌件A），挂嵌件A 的 BOM 出快照
      const childItem = await db
        .selectFrom('mfg_demand_item')
        .selectAll()
        .where('demand_id', '=', childDemand.id)
        .executeTakeFirstOrThrow()
      expect(childItem.material_id).toBe(compAId)
      const childBomId = await makeActiveBom(
        [{ materialId: compCId, unitId, quantity: '2' }],
        compAId,
      )
      const childWo = await mfg.workOrders.createWorkOrder(permitFor('mfgWorkOrders', 'create'), {
        demandItemId: childItem.id,
        qty: '4',
        bomId: childBomId,
      })
      childWoId = childWo.id

      // 二层：子工单同样带动作，继续向下派生（材料C 报采购）
      const childSnap = await mfg.workOrders.getBomSnapshot(
        permitFor('mfgWorkOrders', 'read'),
        childWo.id,
      )
      expect(childSnap.components).toHaveLength(1)
      const second = await mfg.workOrders.generateMaterialDemand(
        permitFor('mfgWorkOrders', 'generate_material_demand'),
        childWo.id,
        {
          lines: [
            {
              componentId: childSnap.components[0]!.id,
              qty: '8', // 毛需求 = 2 × 4
              target: { kind: 'purchase' },
            },
          ],
        },
      )
      expect(second.warning).toBeNull()
      expect(second.demands).toHaveLength(1)
      expect(second.demands[0]!.assignedDeptId).toBeNull()
      secondDemandId = second.demands[0]!.id

      // 二层派生行来源指向子工单（与一层父工单 parentWo 各自独立）
      const secondItems = await derivedItemsOf(childWo.id)
      expect(secondItems).toHaveLength(1)
      expect(secondItems[0]!.demand_id).toBe(second.demands[0]!.id)
      expect(secondItems[0]!.material_id).toBe(compCId)
      const firstItems = await derivedItemsOf(parentWo.id)
      expect(firstItems).toHaveLength(1)
      expect(firstItems[0]!.demand_id).toBe(childDemand.id)
    } finally {
      if (secondDemandId) {
        await db.deleteFrom('mfg_demand_item').where('demand_id', '=', secondDemandId).execute()
        await db.deleteFrom('mfg_demand').where('id', '=', secondDemandId).execute()
      }
      if (childWoId) {
        await db
          .deleteFrom('sys_attachment')
          .where('owner_type', '=', 'mfg_work_order')
          .where('owner_id', '=', childWoId)
          .execute()
        await db.deleteFrom('mfg_work_order').where('id', '=', childWoId).execute()
      }
      if (childDemandId) {
        await db.deleteFrom('mfg_demand_item').where('demand_id', '=', childDemandId).execute()
        await db.deleteFrom('mfg_demand').where('id', '=', childDemandId).execute()
      }
    }
  })
})
