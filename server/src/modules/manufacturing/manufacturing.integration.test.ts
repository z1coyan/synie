/**
 * 制造域 PG 集成：BOM/工艺主数据、履约需求占用、工单、生产入库容差与完工联动
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createManufacturingServices } from './index.ts'
import { testActor } from '~/platform/authz/testing.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（制造：BOM/需求/工单/入库）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry()))
  const mfg = createManufacturingServices(db, numbering)
  const actor: Actor = testActor({
    // 空 userId → 单据 created_by_id 写 null（避免测试环境无 sys_user 行）
    userId: '',
    username: 'mfg-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const componentId = crypto.randomUUID()
  const virtualMaterialId = crypto.randomUUID()
  const assetMaterialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()

  const cleanupIds = {
    operations: [] as string[],
    templates: [] as string[],
    boms: [] as string[],
    demands: [] as string[],
    workOrders: [] as string[],
    outputs: [] as string[],
    files: [] as string[],
  }

  async function seed(): Promise<void> {
    await db
      .insertInto('bas_currency')
      .values({
        id: currencyId,
        name: `制造币-${suffix}`,
        iso_code: suffix.slice(0, 3).toUpperCase(),
        active: true,
      })
      .execute()
    await db
      .insertInto('bas_company')
      .values({
        id: companyId,
        code: `M${suffix.slice(0, 7)}`,
        name: `制造公司-${suffix}`,
        short_name: `制-${suffix.slice(0, 4)}`,
        base_currency_id: currencyId,
      })
      .execute()
    await db
      .insertInto('bas_unit')
      .values({
        id: unitId,
        unit_type: 'quantity',
        is_base: false,
        name: `制造单位-${suffix}`,
        symbol: `u${suffix.slice(0, 5)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `MC${suffix}`,
        name: `制造分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    await db
      .insertInto('inv_material')
      .values([
        {
          id: materialId,
          code: `FM${suffix}`,
          name: `成品-${suffix}`,
          category_id: categoryId,
          default_unit_id: unitId,
        },
        {
          id: componentId,
          code: `CM${suffix}`,
          name: `配料-${suffix}`,
          category_id: categoryId,
          default_unit_id: unitId,
        },
      ])
      .execute()
    await db
      .insertInto('inv_warehouse')
      .values({
        id: warehouseId,
        name: `制造仓-${suffix}`,
        company_id: companyId,
        is_leaf: true,
        active: true,
        allow_negative: false,
      })
      .execute()
  }

  async function cleanup(): Promise<void> {
    for (const id of cleanupIds.outputs) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('inv_stock_entry').where('voucher_id', '=', id).execute()
      await db.deleteFrom('mfg_output_item').where('output_id', '=', id).execute()
      await db.deleteFrom('mfg_output').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.workOrders) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db
        .deleteFrom('sys_attachment')
        .where('owner_type', '=', 'mfg_work_order')
        .where('owner_id', '=', id)
        .execute()
      await db.deleteFrom('mfg_work_order').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.files) {
      await db.deleteFrom('sys_attachment').where('file_id', '=', id).execute()
      await db.deleteFrom('sys_file').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.demands) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('mfg_demand_item').where('demand_id', '=', id).execute()
      await db.deleteFrom('mfg_demand').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.boms) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('mfg_bom_component').where('bom_id', '=', id).execute()
      await db.deleteFrom('mfg_bom_route').where('bom_id', '=', id).execute()
      await db.deleteFrom('mfg_bom_byproduct').where('bom_id', '=', id).execute()
      await db.deleteFrom('mfg_bom').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.templates) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('mfg_process_template_item').where('template_id', '=', id).execute()
      await db.deleteFrom('mfg_process_template').where('id', '=', id).execute()
    }
    for (const id of cleanupIds.operations) {
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('mfg_operation').where('id', '=', id).execute()
    }
    await db.deleteFrom('inv_warehouse').where('id', '=', warehouseId).execute()
    await db
      .deleteFrom('inv_material')
      .where('id', 'in', [materialId, componentId, virtualMaterialId, assetMaterialId])
      .execute()
    await db.deleteFrom('inv_material_category').where('id', '=', categoryId).execute()
    await db.deleteFrom('bas_unit').where('id', '=', unitId).execute()
    await db.deleteFrom('bas_company').where('id', '=', companyId).execute()
    await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
  }

  afterAll(async () => {
    try {
      await cleanup()
    } finally {
      await db.destroy()
    }
  })

  test('种子数据', async () => {
    await seed()
  })

  test('工序/工艺模板/BOM 配料与模板带入', async () => {
    const op = await mfg.master.createOperation(actor, {
      code: `OP${suffix}`,
      name: `冲网-${suffix}`,
    })
    cleanupIds.operations.push(op.id)
    expect(op.code).toBe(`OP${suffix}`)

    const tpl = await mfg.master.createTemplate(actor, {
      code: `T${suffix}`,
      name: `模板-${suffix}`,
    })
    cleanupIds.templates.push(tpl.id)
    await mfg.master.createTemplateItem(actor, {
      templateId: tpl.id,
      operationId: op.id,
      seq: 10,
      requirement: '注意毛刺',
      isOutsourced: false,
    })

    const bom = await mfg.master.createBom(actor, {
      code: `B${suffix}`,
      materialId,
      planName: '自用',
    })
    cleanupIds.boms.push(bom.id)
    expect(bom.status).toBe('draft')

    const comp = await mfg.master.createComponent(actor, {
      bomId: bom.id,
      materialId: componentId,
      unitId,
      quantity: '2.5',
      lossRate: '0.05',
    })
    expect(comp.quantity).toBe('2.5')
    expect(comp.lossRate).toBe('0.05')

    await expect(
      mfg.master.createComponent(actor, {
        bomId: bom.id,
        materialId, // 自引用
        unitId,
        quantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'validation' })

    const routes = await mfg.master.applyRouteTemplate(actor, bom.id, tpl.id)
    expect(routes).toHaveLength(1)
    expect(routes[0]!.operationId).toBe(op.id)
    expect(routes[0]!.requirement).toBe('注意毛刺')

    await expect(mfg.master.applyRouteTemplate(actor, bom.id, tpl.id)).rejects.toMatchObject({
      code: 'conflict',
    })

    const active = await mfg.master.activateBom(actor, bom.id)
    expect(active.status).toBe('active')
    const inactive = await mfg.master.deactivateBom(actor, bom.id)
    expect(inactive.status).toBe('inactive')
    await expect(mfg.master.deleteBom(actor, bom.id)).rejects.toMatchObject({ code: 'conflict' })
    await mfg.master.activateBom(actor, bom.id)

    const draftOnly = await mfg.master.createBom(actor, {
      code: `BD${suffix}`,
      materialId,
      planName: '可删草稿',
    })
    await mfg.master.deleteBom(actor, draftOnly.id)

    // 工单选 BOM 快照
    const d = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DBOM${suffix}`,
    })
    cleanupIds.demands.push(d.id)
    const li = await mfg.demands.createDemandItem(actor, {
      demandId: d.id,
      idx: 1,
      materialId,
      unitId,
      qty: '2',
    })
    await mfg.demands.confirmDemand(actor, d.id)
    const woBom = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: li.id,
      workOrderNo: `WOB${suffix}`,
    })
    cleanupIds.workOrders.push(woBom.id)
    const applied = await mfg.workOrders.applyBom(actor, woBom.id, bom.id)
    expect(applied.bomId).toBe(bom.id)
    const snap = await mfg.workOrders.getBomSnapshot(actor, woBom.id)
    expect(snap.components).toHaveLength(1)
    expect(snap.routes).toHaveLength(1)
    await mfg.workOrders.applyBom(actor, woBom.id, null)
    expect((await mfg.workOrders.getBomSnapshot(actor, woBom.id)).components).toHaveLength(0)
  })

  test('库存/关闭安排与双投影', async () => {
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DST${suffix}`,
      demandDate: '2026-07-20',
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '100',
      needDate: '2026-07-25',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const afterStock = await mfg.demands.createArrangement(actor, {
      demandItemId: line.id,
      arrangementType: 'stock',
      qty: '40',
    })
    expect(afterStock.arrangedQty).toBe('40')
    expect(afterStock.completedQty).toBe('40')
    expect(afterStock.status).toBe('scheduled')
    const afterClose = await mfg.demands.createArrangement(actor, {
      demandItemId: line.id,
      arrangementType: 'close',
      qty: '60',
    })
    expect(afterClose.arrangedQty).toBe('100')
    expect(afterClose.completedQty).toBe('100')
    expect(afterClose.status).toBe('completed')
    await expect(
      mfg.demands.createArrangement(actor, {
        demandItemId: line.id,
        arrangementType: 'close',
        qty: '1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  test('履约需求确认/自制工单/生产入库完工联动', async () => {
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `D${suffix}`,
      remarks: '集成测试',
    })
    cleanupIds.demands.push(demand.id)
    expect(demand.status).toBe('draft')

    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '100',
      needDate: '2026-08-01',
    })
    expect(line.baseQty).toBe('100')
    expect(line.status).toBe('pending')
    expect(line.fulfillmentMethod).toBeNull()

    const confirmed = await mfg.demands.confirmDemand(actor, demand.id)
    expect(confirmed.status).toBe('confirmed')

    // 分批：先开 40，再开 60；满量后不可再开
    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WO${suffix}`,
      qty: '40',
    })
    cleanupIds.workOrders.push(wo.id)
    expect(wo.status).toBe('in_progress')
    expect(wo.baseQty).toBe('40')
    expect(wo.receivedBaseQty).toBe('0')
    expect(wo.remainingBaseQty).toBe('40')

    const wo2 = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WO2${suffix}`,
      qty: '60',
    })
    cleanupIds.workOrders.push(wo2.id)
    expect(wo2.baseQty).toBe('60')

    await expect(
      mfg.workOrders.createWorkOrder(actor, {
        demandItemId: line.id,
        workOrderNo: `WO3${suffix}`,
        qty: '1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const scheduled = await mfg.demands.getDemandItem(actor, line.id)
    expect(scheduled.status).toBe('scheduled')
    expect(scheduled.arrangedQty).toBe('100')

    const output = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `O${suffix}`,
      warehouseId,
      outputDate: '2026-08-02',
    })
    cleanupIds.outputs.push(output.id)

    // 工单1(40) 分两次入库：30 + 10
    await mfg.outputs.createOutputItem(actor, {
      outputId: output.id,
      idx: 1,
      workOrderId: wo.id,
      unitId,
      warehouseId,
      qty: '30',
    })

    const audited1 = await mfg.outputs.auditOutput(actor, output.id)
    expect(audited1.status).toBe('audited')

    const woMid = await mfg.workOrders.getWorkOrder(actor, wo.id)
    expect(woMid.receivedBaseQty).toBe('30')
    expect(woMid.remainingBaseQty).toBe('10')
    expect(woMid.status).toBe('in_progress')

    const output2 = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `O2${suffix}`,
      warehouseId,
    })
    cleanupIds.outputs.push(output2.id)
    await mfg.outputs.createOutputItem(actor, {
      outputId: output2.id,
      idx: 1,
      workOrderId: wo.id,
      unitId,
      warehouseId,
      qty: '10',
    })
    await mfg.outputs.auditOutput(actor, output2.id)

    const woDone = await mfg.workOrders.getWorkOrder(actor, wo.id)
    expect(woDone.status).toBe('completed')
    expect(woDone.receivedBaseQty).toBe('40')

    // 工单2(60) 一次入满 → 需求行双投影完成
    const output3 = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `O3${suffix}`,
      warehouseId,
    })
    cleanupIds.outputs.push(output3.id)
    await mfg.outputs.createOutputItem(actor, {
      outputId: output3.id,
      idx: 1,
      workOrderId: wo2.id,
      unitId,
      warehouseId,
      qty: '60',
    })
    await mfg.outputs.auditOutput(actor, output3.id)

    const lineDone = await mfg.demands.getDemandItem(actor, line.id)
    expect(lineDone.completedQty).toBe('100')
    expect(lineDone.status).toBe('completed')

    // 作废工单2入库 → 需求行回已安排
    await mfg.outputs.voidOutput(actor, output3.id)
    const wo2Reopen = await mfg.workOrders.getWorkOrder(actor, wo2.id)
    expect(wo2Reopen.status).toBe('in_progress')
    expect(wo2Reopen.receivedBaseQty).toBe('0')
    const lineReopen = await mfg.demands.getDemandItem(actor, line.id)
    expect(lineReopen.status).toBe('scheduled')
    expect(lineReopen.completedQty).toBe('40')
  })

  test('生产入库超入容差硬拦', async () => {
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DT${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '10',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WOT${suffix}`,
    })
    cleanupIds.workOrders.push(wo.id)

    // 默认容差 0：超入 1 应失败
    const output = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `OX${suffix}`,
      warehouseId,
    })
    cleanupIds.outputs.push(output.id)
    await mfg.outputs.createOutputItem(actor, {
      outputId: output.id,
      idx: 1,
      workOrderId: wo.id,
      unitId,
      warehouseId,
      qty: '11',
    })
    await expect(mfg.outputs.auditOutput(actor, output.id)).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  test('生产入库审核复核物料类型：工单建好后改虚拟则拒审', async () => {
    // 独立物料（无库存分录,类型可改）
    const matId = crypto.randomUUID()
    await db
      .insertInto('inv_material')
      .values({
        id: matId,
        code: `TM${suffix}`,
        name: `改型料-${suffix}`,
        category_id: categoryId,
        default_unit_id: unitId,
      })
      .execute()
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DTM${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId: matId,
      unitId,
      qty: '5',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WOTM${suffix}`,
    })
    cleanupIds.workOrders.push(wo.id)
    const output = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `OXM${suffix}`,
      warehouseId,
    })
    cleanupIds.outputs.push(output.id)
    await mfg.outputs.createOutputItem(actor, {
      outputId: output.id,
      idx: 1,
      workOrderId: wo.id,
      unitId,
      warehouseId,
      qty: '5',
    })
    // 工单建好后物料被改为虚拟类（尚无库存分录,允许改）
    await db
      .updateTable('inv_material')
      .set({ material_type: 'VIRTUAL' })
      .where('id', '=', matId)
      .execute()
    await expect(mfg.outputs.auditOutput(actor, output.id)).rejects.toMatchObject({
      code: 'conflict',
      message: '工单物料类型已变更为非库存类,不能生产入库',
    })
    // 审核被拒未落分录;按依赖顺序自清,避免挡住 afterAll 的分类删除
    await db.deleteFrom('mfg_output_item').where('output_id', '=', output.id).execute()
    await db.deleteFrom('mfg_output').where('id', '=', output.id).execute()
    await db.deleteFrom('mfg_demand_arrangement').where('work_order_id', '=', wo.id).execute()
    await db.deleteFrom('mfg_work_order').where('id', '=', wo.id).execute()
    await db.deleteFrom('mfg_demand_item').where('id', '=', line.id).execute()
    await db.deleteFrom('mfg_demand').where('id', '=', demand.id).execute()
    await db.deleteFrom('inv_material').where('id', '=', matId).execute()
  })

  test('兼容点完成→库存安排；改履约方式已取消', async () => {
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DS${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const stockLine = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '5',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const done = await mfg.demands.completeDemandItem(actor, stockLine.id)
    expect(done.status).toBe('completed')
    expect(done.arrangedQty).toBe('5')
    expect(done.completedQty).toBe('5')

    const demand2 = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DC${suffix}`,
    })
    cleanupIds.demands.push(demand2.id)
    const buyLine = await mfg.demands.createDemandItem(actor, {
      demandId: demand2.id,
      idx: 1,
      materialId,
      unitId,
      qty: '3',
    })
    await mfg.demands.confirmDemand(actor, demand2.id)
    await expect(mfg.demands.changeFulfillment(actor, buyLine.id, 'MAKE')).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  test('工单创建复制物料图纸挂接；无图不拦', async () => {
    const fileId = crypto.randomUUID()
    cleanupIds.files.push(fileId)
    await db
      .insertInto('sys_file')
      .values({
        id: fileId,
        storage: 'local',
        key: `mfg-draw-${suffix}`,
        filename: `draw-${suffix}.png`,
        content_type: 'image/png',
        size: '12',
        sha256: 'a'.repeat(64),
      })
      .execute()
    await db
      .insertInto('sys_attachment')
      .values({
        owner_type: 'inv_material',
        owner_id: materialId,
        category: 'drawing',
        file_id: fileId,
        company_id: null,
      })
      .execute()

    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DDRAW${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '8',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WODRAW${suffix}`,
      qty: '8',
    })
    cleanupIds.workOrders.push(wo.id)

    const copied = await db
      .selectFrom('sys_attachment')
      .selectAll()
      .where('owner_type', '=', 'mfg_work_order')
      .where('owner_id', '=', wo.id)
      .where('category', '=', 'drawing')
      .execute()
    expect(copied).toHaveLength(1)
    expect(copied[0]!.file_id).toBe(fileId)
    expect(copied[0]!.company_id).toBe(companyId)

    // 无图物料仍可开工单
    await db
      .deleteFrom('sys_attachment')
      .where('owner_type', '=', 'inv_material')
      .where('owner_id', '=', materialId)
      .execute()
    const demand2 = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DNODRAW${suffix}`,
    })
    cleanupIds.demands.push(demand2.id)
    const line2 = await mfg.demands.createDemandItem(actor, {
      demandId: demand2.id,
      idx: 1,
      materialId,
      unitId,
      qty: '1',
    })
    await mfg.demands.confirmDemand(actor, demand2.id)
    const wo2 = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line2.id,
      workOrderNo: `WONODRAW${suffix}`,
      qty: '1',
    })
    cleanupIds.workOrders.push(wo2.id)
    const none = await db
      .selectFrom('sys_attachment')
      .selectAll()
      .where('owner_type', '=', 'mfg_work_order')
      .where('owner_id', '=', wo2.id)
      .execute()
    expect(none).toHaveLength(0)
  })

  test('创建工单可直接挂启用中 BOM 并快照', async () => {
    const bom = await mfg.master.createBom(actor, {
      code: `BCR${suffix}`,
      materialId,
      planName: '创建时挂',
      status: 'active',
    })
    cleanupIds.boms.push(bom.id)
    await mfg.master.createComponent(actor, {
      bomId: bom.id,
      materialId: componentId,
      unitId,
      quantity: '1.5',
    })
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DCR${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '6',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WOCR${suffix}`,
      qty: '6',
      bomId: bom.id,
    })
    cleanupIds.workOrders.push(wo.id)
    expect(wo.bomId).toBe(bom.id)
    const snap = await mfg.workOrders.getBomSnapshot(actor, wo.id)
    expect(snap.components).toHaveLength(1)
    expect(snap.components[0]!.quantity).toBe('1.5')
  })

  test('工单内嵌创建 BOM：启用态 + 立即选入快照', async () => {
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DINL${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '12',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WOINL${suffix}`,
      qty: '12',
    })
    cleanupIds.workOrders.push(wo.id)

    const { workOrder, bom } = await mfg.workOrders.createInlineBom(actor, wo.id, {
      code: `BINL${suffix}`,
      planName: '工单内嵌',
      components: [
        {
          materialId: componentId,
          unitId,
          quantity: '3',
          lossRate: '0.1',
        },
      ],
    })
    cleanupIds.boms.push(bom.id)
    expect(bom.status).toBe('active')
    expect(bom.materialId).toBe(materialId)
    expect(workOrder.bomId).toBe(bom.id)
    const snap = await mfg.workOrders.getBomSnapshot(actor, wo.id)
    expect(snap.components).toHaveLength(1)
    expect(snap.components[0]!.quantity).toBe('3')
    expect(snap.components[0]!.lossRate).toBe('0.1')
  })

  test('混排矩阵：40 工单 + 30 采购 + 30 关闭 + 入库', async () => {
    // 完整路径：生产安排 + 采购安排（审核倒写语义）+ 关闭 + 生产入库完成判定
    const { recomputeDemandItemProjections } = await import('./arrangement.ts')
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DMX${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '100',
    })
    await mfg.demands.confirmDemand(actor, demand.id)

    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WOMX${suffix}`,
      qty: '40',
    })
    cleanupIds.workOrders.push(wo.id)

    // 模拟已审核采购条目倒写（无 FK 到 pur_order_item，与运行时一致）
    const fakePoItemId = crypto.randomUUID()
    await db
      .insertInto('mfg_demand_arrangement')
      .values({
        demand_item_id: line.id,
        company_id: companyId,
        arrangement_type: 'purchase',
        qty: '30',
        base_qty: '30',
        purchase_order_item_id: fakePoItemId,
      })
      .execute()
    await db
      .updateTable('mfg_demand_item')
      .set({ ordered_qty: '30' })
      .where('id', '=', line.id)
      .execute()
    await recomputeDemandItemProjections(db, line.id)

    await mfg.demands.createArrangement(actor, {
      demandItemId: line.id,
      arrangementType: 'close',
      qty: '30',
    })

    let item = await mfg.demands.getDemandItem(actor, line.id)
    expect(item.arrangedQty).toBe('100')
    expect(item.completedQty).toBe('30') // 仅关闭完成；工单未入、采购未收
    expect(item.status).toBe('scheduled')

    const output = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `OMX${suffix}`,
      warehouseId,
    })
    cleanupIds.outputs.push(output.id)
    await mfg.outputs.createOutputItem(actor, {
      outputId: output.id,
      idx: 1,
      workOrderId: wo.id,
      unitId,
      warehouseId,
      qty: '40',
    })
    await mfg.outputs.auditOutput(actor, output.id)

    item = await mfg.demands.getDemandItem(actor, line.id)
    expect(item.completedQty).toBe('70') // 关闭 30 + 生产入 40
    expect(item.status).toBe('scheduled')

    // 采购入库回写 received → 完成
    await db
      .updateTable('mfg_demand_item')
      .set({ received_qty: '30' })
      .where('id', '=', line.id)
      .execute()
    await recomputeDemandItemProjections(db, line.id)
    item = await mfg.demands.getDemandItem(actor, line.id)
    expect(item.arrangedQty).toBe('100')
    expect(item.completedQty).toBe('100')
    expect(item.status).toBe('completed')

    const arrangements = await mfg.demands.listArrangements(actor, line.id)
    const types = arrangements.map((a) => a.arrangementType).sort()
    expect(types).toEqual(['close', 'make', 'purchase'])
  })

  test('物料类型准入：BOM/工单限库存类，需求行不限但库存安排限库存类', async () => {
    await db
      .insertInto('inv_material')
      .values([
        {
          id: virtualMaterialId,
          code: `VM${suffix}`,
          name: `虚拟料-${suffix}`,
          category_id: categoryId,
          default_unit_id: unitId,
          material_type: 'VIRTUAL',
        },
        {
          id: assetMaterialId,
          code: `AM${suffix}`,
          name: `资产料-${suffix}`,
          category_id: categoryId,
          default_unit_id: unitId,
          material_type: 'ASSET',
        },
      ])
      .execute()

    // BOM 母物料/配料行/副产品行均限库存类
    await expect(
      mfg.master.createBom(actor, {
        code: `BV${suffix}`,
        materialId: virtualMaterialId,
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进该单据'] },
    })
    const bom = await mfg.master.createBom(actor, {
      code: `BS${suffix}`,
      materialId,
    })
    cleanupIds.boms.push(bom.id)
    await expect(
      mfg.master.createComponent(actor, {
        bomId: bom.id,
        materialId: virtualMaterialId,
        unitId,
        quantity: '1',
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进该单据'] },
    })
    await expect(
      mfg.master.createByproduct(actor, {
        bomId: bom.id,
        materialId: assetMaterialId,
        unitId,
        quantity: '1',
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进该单据'] },
    })

    // 需求行不限类型；但生成工单与库存安排限库存类
    const demand = await mfg.demands.createDemand(actor, {
      companyId,
      demandNo: `DMT${suffix}`,
    })
    cleanupIds.demands.push(demand.id)
    const line = await mfg.demands.createDemandItem(actor, {
      demandId: demand.id,
      idx: 1,
      materialId: virtualMaterialId,
      unitId,
      qty: '10',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    await expect(
      mfg.workOrders.createWorkOrder(actor, { demandItemId: line.id }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可进该单据'] },
    })
    await expect(
      mfg.demands.createArrangement(actor, {
        demandItemId: line.id,
        arrangementType: 'stock',
        qty: '5',
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { materialId: ['仅库存类物料可做库存安排'] },
    })
    // 关闭安排不受物料类型限制
    const closed = await mfg.demands.createArrangement(actor, {
      demandItemId: line.id,
      arrangementType: 'close',
      qty: '5',
    })
    expect(closed.arrangedQty).toBe('5')
  })
})
