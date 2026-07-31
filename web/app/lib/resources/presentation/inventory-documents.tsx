/**
 * 「其他库存单」Presentation Extension。
 *
 * Drawer 与 document preview 的动态呈现共置在库存业务 module；全局 registry
 * 只负责把本 module 返回的配置接到通用呈现入口。Catalog 继续只拥有静态字段事实。
 */
import type { ResourceBinding } from '../catalog/types'
import type { DocumentPreviewConfig, PresentationExtension } from './types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import type { Row } from '~/components/synie-data-grid/types'
import type { EditableColumnOverride } from '~/components/synie-editable-table/SynieEditableTable'

export const INVENTORY_DOCUMENT_RESOURCES = [
  'invStockDocs',
  'invStockTransfers',
  'invStockCounts',
] as const

export type InventoryDocumentResource =
  (typeof INVENTORY_DOCUMENT_RESOURCES)[number]

export interface InventoryDocumentPresentation extends PresentationExtension {
  readonly resource: InventoryDocumentResource
  readonly documentPreview: DocumentPreviewConfig
}

const MATERIAL_AUXILIARY_EXCLUDE = [
  'materialId',
  'materialName',
  'materialSpec',
  'customerPartNo',
  'unitName',
] as const

const UNIT_ID_SNAPSHOT_OVERRIDE = {
  render: (_value: unknown, row: Row) =>
    row.unitName != null && row.unitName !== ''
      ? String(row.unitName)
      : undefined,
} satisfies EditableColumnOverride

const BASE_QTY_OVERRIDE = {
  label: '折算数量',
} satisfies EditableColumnOverride

const LINE_REMARK_OVERRIDE = {
  label: '行备注',
} satisfies EditableColumnOverride

const MATERIAL_CODE_OVERRIDE = {
  label: '物料',
  render: materialCellRender(),
} satisfies EditableColumnOverride

function previewHead(
  presentation: Pick<
    PresentationExtension,
    'exclude' | 'fields' | 'contentClassName'
  >,
): DocumentPreviewConfig['head'] {
  return {
    exclude: presentation.exclude,
    fields: presentation.fields,
    contentClassName: presentation.contentClassName,
  }
}

function stockDocumentPresentation(
  binding: ResourceBinding,
): InventoryDocumentPresentation {
  const drawer = {
    label: '手工出入库单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: [
      'status',
      'auditedAt',
      'auditedById',
      'createdById',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      direction: {
        required: true,
        order: 0,
        cols: 6,
        defaultValue: 'IN',
        edit: 'createOnly',
      },
      docNo: { order: 1, cols: 6, placeholder: '留空自动编号' },
      docDate: { order: 2, cols: 6, required: true },
      warehouseId: { order: 3, required: true, label: '仓库' },
      summary: {
        order: 4,
        label: '摘要',
        placeholder: '货从哪来/到哪去(带入库存分录)',
      },
      remarks: { order: 5, label: '备注' },
    },
  } satisfies Pick<
    PresentationExtension,
    'label' | 'contentClassName' | 'exclude' | 'fields'
  >

  return {
    resource: 'invStockDocs',
    kind: 'extension',
    binding,
    ...drawer,
    documentPreview: {
      label: drawer.label,
      docNoField: 'docNo',
      head: previewHead(drawer),
      lineTables: [
        {
          title: '出入库行',
          resource: 'invStockDocItems',
          parentIdField: 'stockDocId',
          columns: [
            'idx',
            'materialCode',
            'unitId',
            'qty',
            'baseQty',
            'remark',
          ],
          exclude: ['stockDocId', 'companyId', ...MATERIAL_AUXILIARY_EXCLUDE],
          overrides: {
            materialCode: MATERIAL_CODE_OVERRIDE,
            unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
            baseQty: BASE_QTY_OVERRIDE,
            remark: LINE_REMARK_OVERRIDE,
          },
        },
      ],
    },
  }
}

function stockTransferPresentation(
  binding: ResourceBinding,
): InventoryDocumentPresentation {
  const drawer = {
    label: '手工调拨单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: [
      'status',
      'shippedAt',
      'shippedById',
      'receivedAt',
      'receivedById',
      'createdById',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      docNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      docDate: { order: 1, cols: 6, required: true },
      fromWarehouseId: {
        order: 2,
        cols: 6,
        required: true,
        label: '调出仓库',
      },
      toWarehouseId: {
        order: 3,
        cols: 6,
        required: true,
        label: '调入仓库',
      },
      transitWarehouseId: {
        order: 4,
        cols: 6,
        required: true,
        label: '在途仓库',
      },
      summary: { order: 5, label: '摘要' },
      remarks: { order: 6, label: '备注' },
    },
  } satisfies Pick<
    PresentationExtension,
    'label' | 'contentClassName' | 'exclude' | 'fields'
  >

  return {
    resource: 'invStockTransfers',
    kind: 'extension',
    binding,
    ...drawer,
    documentPreview: {
      label: drawer.label,
      docNoField: 'docNo',
      head: previewHead(drawer),
      lineTables: [
        {
          title: '调拨行',
          resource: 'invStockTransferItems',
          parentIdField: 'stockTransferId',
          columns: [
            'idx',
            'materialCode',
            'unitId',
            'qty',
            'baseQty',
            'receivedQty',
            'remark',
          ],
          exclude: [
            'stockTransferId',
            'companyId',
            ...MATERIAL_AUXILIARY_EXCLUDE,
          ],
          overrides: {
            materialCode: MATERIAL_CODE_OVERRIDE,
            unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
            baseQty: BASE_QTY_OVERRIDE,
            receivedQty: { label: '实收数量' },
            remark: LINE_REMARK_OVERRIDE,
          },
        },
      ],
    },
  }
}

function stockCountPresentation(
  binding: ResourceBinding,
): InventoryDocumentPresentation {
  const drawer = {
    label: '库存盘点单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: [
      'status',
      'snapshotTakenAt',
      'auditedAt',
      'auditedById',
      'createdById',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      docNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      postingDate: { order: 1, cols: 6, required: true },
      warehouseId: { order: 2, required: true, label: '仓库' },
      summary: { order: 3, label: '摘要' },
      remarks: { order: 4, label: '备注' },
    },
  } satisfies Pick<
    PresentationExtension,
    'label' | 'contentClassName' | 'exclude' | 'fields'
  >

  return {
    resource: 'invStockCounts',
    kind: 'extension',
    binding,
    ...drawer,
    documentPreview: {
      label: drawer.label,
      docNoField: 'docNo',
      head: previewHead(drawer),
      lineTables: [
        {
          title: '盘点行',
          resource: 'invStockCountItems',
          parentIdField: 'countId',
          sortColumn: 'insertedAt',
          columns: [
            'materialCode',
            'unitId',
            'countedQuantity',
            'bookQuantity',
            'difference',
            'remark',
          ],
          exclude: [
            'countId',
            'companyId',
            ...MATERIAL_AUXILIARY_EXCLUDE,
            'convertedCounted',
          ],
          overrides: {
            materialCode: MATERIAL_CODE_OVERRIDE,
            unitId: UNIT_ID_SNAPSHOT_OVERRIDE,
            countedQuantity: { label: '实盘数量' },
            bookQuantity: { label: '账面数量' },
            difference: {
              label: '差异',
              align: 'end',
              render: (_value, row) => {
                if (row.convertedCounted == null || row.bookQuantity == null) {
                  return undefined
                }
                const difference =
                  Math.round(
                    (Number(row.convertedCounted) - Number(row.bookQuantity)) *
                      1e6,
                  ) / 1e6
                if (!Number.isFinite(difference)) return undefined
                return difference < 0 ? (
                  <span className="text-danger">{difference}</span>
                ) : (
                  String(difference)
                )
              },
            },
            remark: LINE_REMARK_OVERRIDE,
          },
        },
      ],
    },
  }
}

/**
 * 唯一外部 interface：由资源的 binding 构造完整动态呈现。
 * 错误或未知资源显式失败，不提供空配置或 Catalog label fallback。
 */
export function createInventoryDocumentPresentation(
  binding: ResourceBinding,
): InventoryDocumentPresentation {
  switch (binding.resource) {
    case 'invStockDocs':
      return stockDocumentPresentation(binding)
    case 'invStockTransfers':
      return stockTransferPresentation(binding)
    case 'invStockCounts':
      return stockCountPresentation(binding)
    default:
      throw new Error(
        `其他库存单 Presentation Extension 不支持资源「${binding.resource}」`,
      )
  }
}
