/**
 * 对账 Meta 字段/动作表面（ResourceDocument v2）。
 */
import { describe, expect, test } from 'bun:test'
import { createRegistry } from '~/platform/meta/registry.ts'
import { reconciliationHeadMeta, reconciliationItemMeta } from './spec.ts'
import { orderFlowItemMeta } from '../../scm/orderflow/meta.ts'
import { testActor } from '~/platform/authz/testing.ts'

describe('对账 Meta 表面', () => {
  test('销售头/行字段与动作', () => {
    const registry = createRegistry()
    registry.register(reconciliationHeadMeta('sales'))
    registry.register(reconciliationItemMeta('sales'))
    const head = registry.buildDocument('salReconciliations', testActor({
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    }))
    const item = registry.buildDocument('salReconciliationItems', testActor({
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    }))
    expect(head.fields.map((c) => c.name)).toEqual([
      'id',
      'reconciliationNo',
      'reconciliationType',
      'partyType',
      'partyId',
      'postingDate',
      'remarks',
      'status',
      'insertedAt',
      'updatedAt',
      'companyId',
      'debitAccountId',
      'creditAccountId',
      'createdById',
      'grossTotal',
      'baseGrossTotal',
    ])
    expect(head.capabilities).toEqual([
      'create',
      'update',
      'delete',
      'confirm',
      'unconfirm',
      'audit',
      'void',
    ])
    expect(head.commands[0]?.label).toBe('客户确认')
    expect(item.fields.map((c) => c.name)).toEqual([
      'id',
      'idx',
      'qty',
      'baseQty',
      'amount',
      'baseAmount',
      'remarks',
      'insertedAt',
      'updatedAt',
      'reconciliationId',
      'companyId',
      'deliveryItemId',
      'reconciliationNo',
      'reconciliationStatus',
      'deliveryNo',
      'deliveryDate',
      'materialName',
      'unitName',
      'orderCurrencyCode',
    ])
    expect(item.capabilities).toEqual([])
  })

  test('采购头/行字段与动作', () => {
    const registry = createRegistry()
    registry.register(reconciliationHeadMeta('purchase'))
    registry.register(reconciliationItemMeta('purchase'))
    const head = registry.buildDocument('purReconciliations', testActor({
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    }))
    expect(head.commands[0]?.label).toBe('供应商确认')
    const item = registry.buildDocument('purReconciliationItems', testActor({
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    }))
    expect(item.fields.map((c) => c.name)).toContain('receiptItemId')
    expect(item.fields.map((c) => c.name)).toContain('outsourcedReceiptItemId')
  })

  test('订单流 Meta 为 OR 读权限投影', () => {
    const registry = createRegistry()
    registry.register(orderFlowItemMeta())
    const doc = registry.buildDocument('scmOrderFlowItems', testActor({
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    }))
    expect(doc.fields.map((c) => c.name)).toContain('flowType')
    expect(doc.capabilities).toEqual([])
  })
})
