import { describe, expect, test } from 'bun:test'
import { isValidElement } from 'react'
import {
  drawerConfig,
  listDrawerConfigKeys,
} from '~/components/synie-record-drawer/extension-drawer-props'
import {
  getDocumentPreview,
  listDocumentPreviewKeys,
} from '~/components/synie-record-drawer/document-preview'
import '~/components/synie-record-drawer/document-preview-registry'
import { listPresentationResources, presentationFor } from './registry'

const EXPECTED_RESOURCES = [
  'accBills',
  'hrPayrolls',
  'invStockCounts',
  'invStockDocs',
  'invStockTransfers',
  'mfgBoms',
  'mfgDemands',
  'mfgOutputs',
  'mfgProcessTemplates',
  'mfgWorkOrders',
  'purOrders',
  'purOutsourcedIssues',
  'purOutsourcedReceipts',
  'purQuotations',
  'purReceipts',
  'purReconciliations',
  'salDeliveries',
  'salOrders',
  'salQuotations',
  'salReconciliations',
  'sysRoles',
]

const EXPECTED_PREVIEWS = [
  'invStockCounts',
  'invStockDocs',
  'invStockTransfers',
  'mfgOutputs',
  'purOutsourcedIssues',
  'purOutsourcedReceipts',
  'purReceipts',
  'salDeliveries',
]

describe('Presentation Extension 薄 registry interface', () => {
  test('21 个实际调用资源均由业务 module 构造', () => {
    expect(listPresentationResources()).toEqual(EXPECTED_RESOURCES)
    expect(listDrawerConfigKeys()).toEqual(EXPECTED_RESOURCES)

    for (const resource of EXPECTED_RESOURCES) {
      const presentation = presentationFor(resource)
      const drawer = drawerConfig(resource)

      expect(presentation.resource).toBe(resource)
      expect(presentation.binding.resource).toBe(resource)
      expect(presentation.kind).toBe('extension')
      expect(drawer.label).toBe(presentation.label)
      expect(drawer.exclude).toEqual(presentation.exclude)
      expect(drawer.fields).toEqual(presentation.fields)
    }
  })

  test('8 个专用 document preview 从同一个 Presentation module interface 装配', () => {
    expect(listDocumentPreviewKeys()).toEqual(EXPECTED_PREVIEWS)

    for (const resource of EXPECTED_RESOURCES) {
      const presentation = presentationFor(resource)
      const registered = getDocumentPreview(resource)
      if (!presentation.documentPreview) {
        expect(registered).toBeNull()
        continue
      }
      expect(registered?.label).toBe(presentation.documentPreview.label)
      expect(registered?.docNoField).toBe(
        presentation.documentPreview.docNoField,
      )
      expect(registered?.lineTables.map((table) => table.resource)).toEqual(
        presentation.documentPreview.lineTables.map((table) => table.resource),
      )
      for (const table of registered?.lineTables ?? []) {
        expect(table).not.toHaveProperty('client')
      }
    }
  })

  test('跨业务域差异经同一小 interface 保留', () => {
    const salesOrder = presentationFor('salOrders')
    expect(salesOrder.fields.partyType?.effects?.('CUSTOMER')).toEqual({
      partyId: null,
    })
    expect(
      salesOrder.fields.partyId?.visible?.({
        partyType: 'CUSTOMER',
      }),
    ).toBe(true)

    const outsourced = presentationFor('purOutsourcedReceipts')
    expect(outsourced.fields.partyType?.effects?.('SUPPLIER')).toEqual({
      partyId: null,
      outsourcedWarehouseId: null,
    })
    expect(outsourced.fields.partyId?.effects?.('supplier-1')).toEqual({
      outsourcedWarehouseId: null,
    })

    const workOrder = presentationFor('mfgWorkOrders')
    expect(workOrder.fields.demandItemId?.picker).toBe('dialog')
    expect(workOrder.fields.demandItemId?.dialog?.gridColumns).toEqual([
      'companyId',
      'demandId',
      'idx',
      'materialCode',
      'materialName',
      'materialSpec',
      'qty',
      'remainingArrangeableQty',
      'unitName',
      'needDate',
      'status',
    ])
    expect(workOrder.fields.demandItemId?.dialog?.gridDefaultSort).toEqual({
      column: 'needDate',
      direction: 'ascending',
    })
    expect(workOrder.fields.demandItemId?.dialog?.gridExtraFields).toEqual([
      'materialId',
      'unitId',
    ])
    for (const field of [
      'companyId',
      'demandId',
      'materialId',
      'unitId',
      'needDate',
      'materialCode',
      'materialName',
      'materialSpec',
      'unitName',
    ]) {
      expect(workOrder.fields[field]?.edit, field).toBe('readOnly')
    }
    expect(workOrder.fields.qty?.edit).toBe('createOnly')
    expect(workOrder.fields.bomId?.section).toBe('配方')
    expect(
      workOrder.fields.demandItemId?.effects?.('demand-item-1', {
        id: 'demand-item-1',
        companyId: 'company-1',
        demandId: 'demand-1',
        materialId: 'material-1',
        unitId: 'unit-1',
        remainingArrangeableQty: '3',
      }),
    ).toMatchObject({
      companyId: 'company-1',
      demandId: 'demand-1',
      materialId: 'material-1',
      unitId: 'unit-1',
      qty: '3',
      bomId: null,
    })

    expect(
      presentationFor('hrPayrolls').fields.payable?.render?.('1234.5', {
        id: 'payroll-1',
      }),
    ).toBe('1,234.50')

    const billExtra = presentationFor('accBills').extraContent?.(
      'view',
      { id: 'bill-1' },
      {},
      () => {},
    )
    expect(isValidElement(billExtra)).toBe(true)
  })

  test('未知资源与缺省 preview 继续 fail-closed', () => {
    expect(() => presentationFor('__unknown__')).toThrow(
      /无 Presentation Extension/,
    )
    expect(() => drawerConfig('__unknown__')).toThrow(
      /无 Presentation Extension/,
    )
    expect(getDocumentPreview('__unknown__')).toBeNull()
    expect(getDocumentPreview('salOrders')).toBeNull()
  })
})
