/**
 * 制造域 PG 集成：BOM/工艺主数据、履约需求占用、工单、生产入库容差与完工联动
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { createDb } from '~/db/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createNumberingService } from '~/platform/numbering/index.ts'
import { createManufacturingServices } from './index.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（制造：BOM/需求/工单/入库）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db)
  const mfg = createManufacturingServices(db, numbering)
  const actor: Actor = {
    // 空 userId → 单据 created_by_id 写 null（避免测试环境无 sys_user 行）
    userId: '',
    username: 'mfg-test',
    name: null,
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const componentId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()

  const cleanupIds = {
    operations: [] as string[],
    templates: [] as string[],
    boms: [] as string[],
    demands: [] as string[],
    workOrders: [] as string[],
    outputs: [] as string[],
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
      await db.deleteFrom('mfg_work_order').where('id', '=', id).execute()
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
    await db.deleteFrom('inv_material').where('id', 'in', [materialId, componentId]).execute()
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
      fulfillmentMethod: 'MAKE',
      needDate: '2026-08-01',
    })
    expect(line.baseQty).toBe('100')
    expect(line.status).toBe('pending')
    expect(line.fulfillmentMethod).toBe('make')

    const confirmed = await mfg.demands.confirmDemand(actor, demand.id)
    expect(confirmed.status).toBe('confirmed')

    // 自制行不可直接点完成
    await expect(mfg.demands.completeDemandItem(actor, line.id)).rejects.toMatchObject({
      code: 'conflict',
    })

    const wo = await mfg.workOrders.createWorkOrder(actor, {
      demandItemId: line.id,
      workOrderNo: `WO${suffix}`,
    })
    cleanupIds.workOrders.push(wo.id)
    expect(wo.status).toBe('in_progress')
    expect(wo.baseQty).toBe('100')
    expect(wo.receivedBaseQty).toBe('0')
    expect(wo.remainingBaseQty).toBe('100')

    // 一需求行至多一张未作废工单
    await expect(
      mfg.workOrders.createWorkOrder(actor, {
        demandItemId: line.id,
        workOrderNo: `WO2${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const scheduled = await mfg.demands.getDemandItem(actor, line.id)
    expect(scheduled.status).toBe('scheduled')

    const output = await mfg.outputs.createOutput(actor, {
      companyId,
      outputNo: `O${suffix}`,
      warehouseId,
      outputDate: '2026-08-02',
    })
    cleanupIds.outputs.push(output.id)

    await mfg.outputs.createOutputItem(actor, {
      outputId: output.id,
      idx: 1,
      workOrderId: wo.id,
      unitId,
      warehouseId,
      qty: '60',
    })

    const audited1 = await mfg.outputs.auditOutput(actor, output.id)
    expect(audited1.status).toBe('audited')

    const woMid = await mfg.workOrders.getWorkOrder(actor, wo.id)
    expect(woMid.receivedBaseQty).toBe('60')
    expect(woMid.remainingBaseQty).toBe('40')
    expect(woMid.status).toBe('in_progress')

    // 第二次入库满量
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
      qty: '40',
    })
    await mfg.outputs.auditOutput(actor, output2.id)

    const woDone = await mfg.workOrders.getWorkOrder(actor, wo.id)
    expect(woDone.status).toBe('completed')
    expect(woDone.receivedBaseQty).toBe('100')
    expect(decimal(woDone.remainingBaseQty).eq(0)).toBe(true)

    const lineDone = await mfg.demands.getDemandItem(actor, line.id)
    expect(lineDone.status).toBe('completed')

    // 作废第二张入库 → 工单回进行中、需求行回已安排
    await mfg.outputs.voidOutput(actor, output2.id)
    const woReopen = await mfg.workOrders.getWorkOrder(actor, wo.id)
    expect(woReopen.status).toBe('in_progress')
    expect(woReopen.receivedBaseQty).toBe('60')
    const lineReopen = await mfg.demands.getDemandItem(actor, line.id)
    expect(lineReopen.status).toBe('scheduled')
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
      fulfillmentMethod: 'MAKE',
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

  test('库存行点完成 / 改履约方式', async () => {
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
      fulfillmentMethod: 'STOCK',
    })
    await mfg.demands.confirmDemand(actor, demand.id)
    const done = await mfg.demands.completeDemandItem(actor, stockLine.id)
    expect(done.status).toBe('completed')

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
      fulfillmentMethod: 'BUY',
    })
    await mfg.demands.confirmDemand(actor, demand2.id)
    const changed = await mfg.demands.changeFulfillment(actor, buyLine.id, 'MAKE')
    expect(changed.fulfillmentMethod).toBe('make')
  })
})
