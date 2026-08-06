import { describe, expect, test } from 'bun:test'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import {
  demandItemResourceMeta,
  demandResourceMeta,
  outputItemResourceMeta,
  workOrderResourceMeta,
} from './meta.ts'

describe('制造资源 Meta', () => {
  test('履约需求行的采购履约投影只读', () => {
    const fields = new Map(
      demandItemResourceMeta().fields.map((field) => [field.apiName, field]),
    )

    for (const name of [
      'orderedQty',
      'receivedQty',
      'ordered',
      'remainingOrderableQty',
    ]) {
      expect(fields.get(name)?.readonly).toBe(true)
    }
    expect(fields.get('ordered')?.calculated).toBe(true)
    expect(fields.get('remainingOrderableQty')?.calculated).toBe(true)
  })

  test('履约需求单以审核命令复用既有确认权限', () => {
    const audit = demandResourceMeta().actions.find(
      (action) => action.key === 'audit',
    )

    expect(audit).toMatchObject({
      label: '审核',
      scope: 'row',
      permissionAction: 'confirm',
      confirmKind: 'audit_doc',
    })
    expect(
      demandResourceMeta().actions.some((action) => action.key === 'confirm'),
    ).toBe(false)
  })

  test('生产入库条目暴露母单号/日期/状态 calculated 列（条目 tab 筛排）', () => {
    const fields = new Map(
      outputItemResourceMeta().fields.map((field) => [field.apiName, field]),
    )
    expect(fields.get('outputNo')).toMatchObject({
      dbColumn: 'output_no',
      calculated: true,
      filterable: true,
      sortable: true,
    })
    expect(fields.get('outputDate')).toMatchObject({
      dbColumn: 'output_date',
      calculated: true,
      filterable: true,
      sortable: true,
    })
    expect(fields.get('outputStatus')).toMatchObject({
      dbColumn: 'output_status',
      calculated: true,
      filterable: true,
      sortable: true,
    })
  })

  test('工单声明「生成物料需求」row 级动作且权限码入目录', () => {
    const action = workOrderResourceMeta().actions.find(
      (a) => a.key === 'generate_material_demand',
    )
    expect(action).toMatchObject({ label: '生成物料需求', scope: 'row' })

    const registry = createSealedResourceRegistry()
    expect(registry.allPermissionCodes()).toContain(
      'mfg.work_order:generate_material_demand',
    )
  })

  test('需求行来源工单字段：fk 只读投影（与销售来源互斥，不进表单）', () => {
    const fields = new Map(
      demandItemResourceMeta().fields.map((field) => [field.apiName, field]),
    )
    const field = fields.get('sourceWorkOrderId')
    expect(field).toMatchObject({
      dbColumn: 'source_work_order_id',
      type: 'fk',
      readonly: true,
    })
    expect(field?.ref).toMatchObject({ resource: 'mfgWorkOrders' })
  })
})
