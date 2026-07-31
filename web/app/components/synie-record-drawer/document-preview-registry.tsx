/**
 * 库存来源单据只读速览登记（Fk 全局入口）。
 * 侧效：import 本模块即 registerDocumentPreview。
 */
import { materialCellRender } from '../synie-material-cell/MaterialCell'
import {
  purchaseOutsourcedIssueItemClient,
  purchaseOutsourcedReceiptItemByproductClient,
  purchaseOutsourcedReceiptItemClient,
  purchaseOutsourcedReceiptItemMaterialClient,
  purchaseReceiptItemClient,
  salesDeliveryItemClient,
} from '~/lib/resources/fulfillment'
import {
  stockCountItemClient,
  stockDocItemClient,
  stockTransferItemClient,
} from '~/lib/resources/inventory'
import { outputItemClient } from '~/lib/resources/manufacturing'
import type { Row } from '../synie-data-grid/types'
import type { EditableColumnOverride } from '../synie-editable-table/SynieEditableTable'
import { drawerConfig } from './extension-drawer-props'
import { registerDocumentPreview } from './document-preview'

const MATERIAL_AUXILIARY_EXCLUDE = [
  'materialId',
  'materialName',
  'materialSpec',
  'customerPartNo',
  'unitName',
] as const

const UNIT_NAME_OVERRIDE = { label: '单位' } satisfies EditableColumnOverride
const BASE_QTY_OVERRIDE = { label: '折算数量' } satisfies EditableColumnOverride
const LINE_REMARK_OVERRIDE = { label: '行备注' } satisfies EditableColumnOverride
const ORDER_NO_OVERRIDE = {
  label: '订单',
  render: (_v: unknown, row: Row) =>
    row.orderNo != null && row.orderNo !== '' ? String(row.orderNo) : undefined,
} satisfies EditableColumnOverride

const UNIT_ID_SNAPSHOT_OVERRIDE = {
  render: (_v: unknown, row: Row) =>
    row.unitName != null && row.unitName !== '' ? String(row.unitName) : undefined,
} satisfies EditableColumnOverride

function materialCodeOverride({
  label = '物料',
  drawingOwnerType,
  wide = false,
}: {
  label?: string
  drawingOwnerType?: string
  wide?: boolean
} = {}): EditableColumnOverride {
  return {
    label,
    ...(wide ? { className: 'min-w-[12rem] max-w-[18rem]' } : {}),
    render: materialCellRender(drawingOwnerType ? { drawingOwnerType } : undefined),
  }
}

function headFromDrawer(resource: string) {
  const cfg = drawerConfig(resource)
  return {
    exclude: cfg.exclude,
    fields: cfg.fields,
    contentClassName: cfg.contentClassName,
  }
}

/** 业务抽屉里 hidden 的科目槽，速览改为可见只读字段 */
function unhideAccounts(
  fields: NonNullable<ReturnType<typeof drawerConfig>['fields']>,
): NonNullable<ReturnType<typeof drawerConfig>['fields']> {
  const next = { ...fields }
  for (const key of ['debitAccountId', 'creditAccountId'] as const) {
    if (next[key]) {
      next[key] = { ...next[key], hidden: false, order: next[key].order ?? 100 }
    }
  }
  return next
}

// —— 其他库存单 ——

registerDocumentPreview('invStockDocs', {
  label: '手工出入库单',
  docNoField: 'docNo',
  head: headFromDrawer('invStockDocs'),
  lineTables: [
    {
      title: '出入库行',
      resource: 'invStockDocItems',
      client: stockDocItemClient,
      parentIdField: 'stockDocId',
      columns: ['idx', 'materialCode', 'unitId', 'qty', 'baseQty', 'remark'],
      exclude: ['stockDocId', 'companyId', ...MATERIAL_AUXILIARY_EXCLUDE],
      overrides: {
        materialCode: materialCodeOverride(),
        unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
        baseQty: BASE_QTY_OVERRIDE,
        remark: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

registerDocumentPreview('invStockTransfers', {
  label: '手工调拨单',
  docNoField: 'docNo',
  head: headFromDrawer('invStockTransfers'),
  lineTables: [
    {
      title: '调拨行',
      resource: 'invStockTransferItems',
      client: stockTransferItemClient,
      parentIdField: 'stockTransferId',
      columns: ['idx', 'materialCode', 'unitId', 'qty', 'baseQty', 'receivedQty', 'remark'],
      exclude: ['stockTransferId', 'companyId', ...MATERIAL_AUXILIARY_EXCLUDE],
      overrides: {
        materialCode: materialCodeOverride(),
        unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
        baseQty: BASE_QTY_OVERRIDE,
        receivedQty: { label: '实收数量' },
        remark: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

registerDocumentPreview('invStockCounts', {
  label: '库存盘点单',
  docNoField: 'docNo',
  head: headFromDrawer('invStockCounts'),
  lineTables: [
    {
      title: '盘点行',
      resource: 'invStockCountItems',
      client: stockCountItemClient,
      parentIdField: 'countId',
      // 盘点行无 idx 列，与业务抽屉一致按 insertedAt 排序
      sortColumn: 'insertedAt',
      columns: ['materialCode', 'unitId', 'countedQuantity', 'bookQuantity', 'difference', 'remark'],
      exclude: [
        'countId',
        'companyId',
        ...MATERIAL_AUXILIARY_EXCLUDE,
        'convertedCounted',
      ],
      overrides: {
        materialCode: materialCodeOverride(),
        unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
        countedQuantity: { label: '实盘数量' },
        bookQuantity: { label: '账面数量' },
        difference: {
          label: '差异',
          align: 'end',
          render: (_v, r) => {
            if (r.convertedCounted == null || r.bookQuantity == null) return undefined
            const n =
              Math.round((Number(r.convertedCounted) - Number(r.bookQuantity)) * 1e6) / 1e6
            if (!Number.isFinite(n)) return undefined
            // 负差异用 danger 色（与盘点业务抽屉一致）
            return n < 0 ? <span className="text-danger">{n}</span> : String(n)
          },
        },
        remark: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

// —— 标准履约 ——

const salDeliveryHead = headFromDrawer('salDeliveries')
registerDocumentPreview('salDeliveries', {
  label: '销售发货单',
  docNoField: 'deliveryNo',
  head: {
    ...salDeliveryHead,
    fields: unhideAccounts(salDeliveryHead.fields ?? {}),
  },
  lineTables: [
    {
      title: '发货条目',
      resource: 'salDeliveryItems',
      client: salesDeliveryItemClient,
      parentIdField: 'deliveryId',
      columns: [
        'idx',
        'orderItemId',
        'materialCode',
        'unitName',
        'qty',
        'warehouseId',
        'baseQty',
        'remarks',
      ],
      exclude: [
        'deliveryId',
        'companyId',
        'materialId',
        'materialName',
        'materialSpec',
        'customerPartNo',
        'deliveryNo',
        'deliveryDate',
        'deliveryStatus',
        'partyType',
        'partyId',
        'orderQty',
        'orderBaseQty',
        'orderUnitName',
        'orderPrice',
        'orderAmount',
        'orderBasePrice',
        'orderBaseAmount',
        'orderTaxRate',
        'orderCurrencyCode',
        'orderNo',
      ],
      overrides: {
        orderItemId: ORDER_NO_OVERRIDE,
        materialCode: materialCodeOverride({
          drawingOwnerType: 'sal_delivery_item',
          wide: true,
        }),
        unitName: UNIT_NAME_OVERRIDE,
        baseQty: BASE_QTY_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

const purReceiptHead = headFromDrawer('purReceipts')
registerDocumentPreview('purReceipts', {
  label: '采购入库单',
  docNoField: 'receiptNo',
  head: {
    ...purReceiptHead,
    fields: unhideAccounts(purReceiptHead.fields ?? {}),
  },
  lineTables: [
    {
      title: '入库条目',
      resource: 'purReceiptItems',
      client: purchaseReceiptItemClient,
      parentIdField: 'receiptId',
      columns: [
        'idx',
        'orderItemId',
        'materialCode',
        'unitName',
        'qty',
        'warehouseId',
        'baseQty',
        'remarks',
      ],
      exclude: [
        'receiptId',
        'companyId',
        'materialId',
        'materialName',
        'materialSpec',
        'customerPartNo',
        'receiptNo',
        'receiptDate',
        'receiptStatus',
        'partyType',
        'partyId',
        'orderQty',
        'orderBaseQty',
        'orderUnitName',
        'orderPrice',
        'orderAmount',
        'orderBasePrice',
        'orderBaseAmount',
        'orderTaxRate',
        'orderCurrencyCode',
        'orderNo',
      ],
      overrides: {
        orderItemId: ORDER_NO_OVERRIDE,
        materialCode: materialCodeOverride({
          drawingOwnerType: 'pur_receipt_item',
          wide: true,
        }),
        unitName: UNIT_NAME_OVERRIDE,
        baseQty: BASE_QTY_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

registerDocumentPreview('mfgOutputs', {
  label: '生产入库单',
  docNoField: 'outputNo',
  head: headFromDrawer('mfgOutputs'),
  lineTables: [
    {
      title: '入库条目',
      resource: 'mfgOutputItems',
      client: outputItemClient,
      parentIdField: 'outputId',
      columns: ['idx', 'materialCode', 'workOrderId', 'unitId', 'qty', 'warehouseId', 'remarks'],
      exclude: [
        'outputId',
        'companyId',
        'materialId',
        'baseQty',
        'materialName',
        'materialSpec',
        'unitName',
        'outputNo',
        'outputDate',
        'outputStatus',
      ],
      overrides: {
        materialCode: materialCodeOverride({ wide: true }),
        unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

// —— 委外 ——

registerDocumentPreview('purOutsourcedIssues', {
  label: '委外发料单',
  docNoField: 'issueNo',
  head: headFromDrawer('purOutsourcedIssues'),
  lineTables: [
    {
      title: '发料条目',
      resource: 'purOutsourcedIssueItems',
      client: purchaseOutsourcedIssueItemClient,
      parentIdField: 'issueId',
      columns: [
        'idx',
        'orderItemMaterialId',
        'materialCode',
        'unitName',
        'qty',
        'fromWarehouseId',
        'outsourcedWarehouseId',
        'baseQty',
        'remarks',
      ],
      exclude: [
        'issueId',
        'companyId',
        'issueNo',
        'issueDate',
        'issueStatus',
        'partyType',
        'partyId',
        'materialId',
        'materialName',
        'materialSpec',
      ],
      overrides: {
        orderItemMaterialId: ORDER_NO_OVERRIDE,
        materialCode: materialCodeOverride({ label: '材料', wide: true }),
        unitName: UNIT_NAME_OVERRIDE,
        fromWarehouseId: { label: '调出仓' },
        outsourcedWarehouseId: { label: '外协仓' },
        baseQty: BASE_QTY_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

const purOutsourcedReceiptHead = headFromDrawer('purOutsourcedReceipts')
registerDocumentPreview('purOutsourcedReceipts', {
  label: '委外入库单',
  docNoField: 'receiptNo',
  head: {
    ...purOutsourcedReceiptHead,
    fields: unhideAccounts(purOutsourcedReceiptHead.fields ?? {}),
  },
  lineTables: [
    {
      title: '成品入库行',
      resource: 'purOutsourcedReceiptItems',
      client: purchaseOutsourcedReceiptItemClient,
      parentIdField: 'receiptId',
      columns: [
        'idx',
        'orderItemId',
        'materialCode',
        'unitName',
        'qty',
        'warehouseId',
        'baseQty',
        'remarks',
      ],
      exclude: [
        'receiptId',
        'companyId',
        'materialId',
        'materialName',
        'materialSpec',
        'customerPartNo',
      ],
      overrides: {
        orderItemId: ORDER_NO_OVERRIDE,
        materialCode: materialCodeOverride({ wide: true }),
        unitName: UNIT_NAME_OVERRIDE,
        baseQty: BASE_QTY_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
    {
      title: '材料扣减行',
      resource: 'purOutsourcedReceiptItemMaterials',
      client: purchaseOutsourcedReceiptItemMaterialClient,
      parentIdField: 'receiptItemId',
      load: async (receiptId) => loadOutsourcedChildRows(receiptId, 'material'),
      columns: [
        'idx',
        'receiptItemId',
        'materialCode',
        'unitName',
        'qty',
        'outsourcedWarehouseId',
        'baseQty',
        'remarks',
      ],
      exclude: [
        'companyId',
        'receiptNo',
        'orderNo',
        'materialId',
        'materialName',
        'materialSpec',
      ],
      overrides: {
        receiptItemId: { label: '入库条目' },
        materialCode: materialCodeOverride({ label: '材料' }),
        unitName: UNIT_NAME_OVERRIDE,
        qty: { label: '扣减数量' },
        outsourcedWarehouseId: { label: '外协仓' },
        baseQty: BASE_QTY_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
    {
      title: '副产物行',
      resource: 'purOutsourcedReceiptItemByproducts',
      client: purchaseOutsourcedReceiptItemByproductClient,
      parentIdField: 'receiptItemId',
      load: async (receiptId) => loadOutsourcedChildRows(receiptId, 'byproduct'),
      columns: [
        'idx',
        'receiptItemId',
        'materialCode',
        'unitName',
        'qty',
        'warehouseId',
        'baseQty',
        'remarks',
      ],
      exclude: [
        'companyId',
        'receiptNo',
        'orderNo',
        'materialId',
        'materialName',
        'materialSpec',
      ],
      overrides: {
        receiptItemId: { label: '入库条目' },
        materialCode: materialCodeOverride(),
        unitName: UNIT_NAME_OVERRIDE,
        qty: { label: '入库数量' },
        baseQty: BASE_QTY_OVERRIDE,
        remarks: LINE_REMARK_OVERRIDE,
      },
    },
  ],
})

async function loadOutsourcedChildRows(
  receiptId: string,
  kind: 'material' | 'byproduct',
): Promise<Row[]> {
  const items = await purchaseOutsourcedReceiptItemClient.query({
    limit: 200,
    offset: 0,
    sort: { column: 'idx', direction: 'ascending' },
    filter: {
      receiptId: { kind: 'fk', op: 'in', values: [receiptId], labels: [] },
    },
  })
  const itemIds = items.results.map((r) => String(r.id))
  if (itemIds.length === 0) return []
  const client =
    kind === 'material'
      ? purchaseOutsourcedReceiptItemMaterialClient
      : purchaseOutsourcedReceiptItemByproductClient
  const result = await client.query({
    limit: 200,
    offset: 0,
    sort: { column: 'idx', direction: 'ascending' },
    filter: {
      receiptItemId: { kind: 'fk', op: 'in', values: itemIds, labels: [] },
    },
  })
  return result.results
}
