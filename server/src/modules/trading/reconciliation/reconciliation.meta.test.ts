/**
 * 对账 Meta 字段/动作表面（对齐 Go meta_test 契约）。
 */
import { describe, expect, test } from 'bun:test'
import { createRegistry } from '~/platform/meta/registry.ts'
import { reconciliationHeadMeta, reconciliationItemMeta } from './spec.ts'
import { orderFlowItemMeta } from '../../scm/orderflow/meta.ts'

describe('对账 Meta 表面', () => {
  test('销售头/行字段与动作', () => {
    const registry = createRegistry()
    registry.register(reconciliationHeadMeta('sales'))
    registry.register(reconciliationItemMeta('sales'))
    // 引用目标资源占位，避免投影引用失败（测试仅校验列名）
    const head = registry.buildDocument('salReconciliations', {
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    })
    const item = registry.buildDocument('salReconciliationItems', {
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    })
    expect(head.grid.columns.map((c) => c.name)).toEqual([
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
    expect(head.grid.capabilities).toEqual([
      'create',
      'update',
      'delete',
      'confirm',
      'unconfirm',
      'audit',
      'void',
    ])
    expect(head.grid.extendedActions?.[0]?.label).toBe('客户确认')
    expect(item.grid.columns.map((c) => c.name)).toEqual([
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
    expect(item.grid.capabilities).toEqual([])
  })

  test('采购头/行字段与动作', () => {
    const registry = createRegistry()
    registry.register(reconciliationHeadMeta('purchase'))
    registry.register(reconciliationItemMeta('purchase'))
    const head = registry.buildDocument('purReconciliations', {
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    })
    expect(head.grid.extendedActions?.[0]?.label).toBe('供应商确认')
    const item = registry.buildDocument('purReconciliationItems', {
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    })
    expect(item.grid.columns.map((c) => c.name)).toContain('receiptItemId')
    expect(item.grid.columns.map((c) => c.name)).toContain('outsourcedReceiptItemId')
  })

  test('订单流 Meta 为 OR 读权限投影', () => {
    const registry = createRegistry()
    registry.register(orderFlowItemMeta())
    const doc = registry.buildDocument('scmOrderFlowItems', {
      userId: '',
      username: 'sa',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    })
    expect(doc.grid.columns.map((c) => c.name)).toContain('flowType')
    expect(doc.grid.capabilities).toEqual([])
  })
})
