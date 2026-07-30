import { describe, expect, test } from 'bun:test'
import { demandItemResourceMeta, demandResourceMeta } from './meta.ts'

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
})
