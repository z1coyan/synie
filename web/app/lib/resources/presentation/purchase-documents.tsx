/**
 * 采购单据 Presentation Extension。
 *
 * Drawer 与三类库存来源 document preview 共置；各单据的审核配置继续由对应
 * 业务 drawer module 导出。
 */
import { Label, TextArea, TextField } from '@heroui/react'
import type { ResourceBinding } from '../catalog/types'
import {
  AUDIT_TRAIL_EXCLUDE,
  BASE_QTY_OVERRIDE,
  LINE_REMARK_OVERRIDE,
  ORDER_NO_OVERRIDE,
  materialCodeOverride,
  previewHead,
  UNIT_NAME_OVERRIDE,
} from './document-preview-helpers'
import {
  presentationFromDefinitions,
  type PresentationDefinition,
} from './group'
import { tradingPartyFields } from './trading-party-fields'
import type {
  DocumentPreviewConfig,
  DocumentPreviewReaderResolver,
  PresentationExtension,
} from './types'
import type { Row } from '~/components/synie-data-grid/types'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'

export const PURCHASE_DOCUMENT_RESOURCES = [
  'purQuotations',
  'purOrders',
  'purReceipts',
  'purOutsourcedReceipts',
  'purOutsourcedIssues',
  'purReconciliations',
] as const

export type PurchaseDocumentResource =
  (typeof PURCHASE_DOCUMENT_RESOURCES)[number]

function longTextField(
  label: string,
  placeholder: string,
  order: number,
): FieldOverride {
  return {
    order,
    label,
    input: ({ value, onChange, isDisabled }) => (
      <TextField
        value={value == null ? '' : String(value)}
        onChange={onChange}
        isDisabled={isDisabled}
      >
        <Label>{label}</Label>
        <TextArea rows={4} placeholder={placeholder} />
      </TextField>
    ),
  }
}

const DEFINITIONS = {
  purQuotations: {
    label: '采购报价单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      quotationNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      quotationDate: { order: 1, cols: 6, required: true },
      validUntil: {
        order: 2,
        cols: 6,
        required: true,
        label: '报价截止',
      },
      ...tradingPartyFields({
        kind: 'purchase',
        typeOrder: 3,
        idOrder: 4,
      }),
      currencyId: {
        order: 5,
        cols: 6,
        required: true,
        label: '币种',
        remote: {
          filterState: { active: { kind: 'bool', eq: true } },
        },
      },
      remarks: { order: 6, label: '报价备注' },
      terms: longTextField(
        '报价条款',
        '对供应商展示的报价条款,如付款、交付、有效条件约定',
        7,
      ),
    },
  },
  purOrders: {
    label: '采购订单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: [...AUDIT_TRAIL_EXCLUDE, 'grossTotal', 'baseGrossTotal'],
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      orderNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      orderDate: { order: 1, cols: 6, required: true },
      ...tradingPartyFields({
        kind: 'purchase',
        typeOrder: 2,
        idOrder: 3,
      }),
      currencyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '币种',
        remote: {
          filterState: { active: { kind: 'bool', eq: true } },
        },
      },
      exchangeRate: {
        order: 5,
        cols: 6,
        label: '汇率',
        placeholder: '如 7.25',
      },
      remarks: { order: 6, label: '订单备注' },
      terms: longTextField(
        '交易条款',
        '对供应商展示的交易条款,如交付、付款、验收约定',
        7,
      ),
    },
  },
  purReceipts: {
    label: '采购入库单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      receiptNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      receiptDate: { order: 1, cols: 6, required: true },
      postingDate: {
        order: 2,
        cols: 6,
        label: '过账日期',
      },
      ...tradingPartyFields({
        kind: 'purchase',
        typeOrder: 3,
        idOrder: 4,
      }),
      warehouseId: {
        order: 5,
        cols: 6,
        label: '默认仓库(可空)',
      },
      remarks: { order: 6, label: '备注' },
      debitAccountId: {
        order: 100,
        cols: 6,
        required: true,
        label: '借方科目',
        hidden: true,
      },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目(未开票应付)',
        hidden: true,
      },
    },
    documentPreview: (presentation): DocumentPreviewConfig => ({
      label: presentation.label,
      docNoField: 'receiptNo',
      head: previewHead(presentation, {
        unhideAccounts: true,
      }),
      lineTables: [
        {
          title: '入库条目',
          resource: 'purReceiptItems',
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
    }),
  },
  purOutsourcedReceipts: {
    label: '委外入库单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      receiptNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      receiptDate: {
        order: 1,
        cols: 6,
        required: true,
        label: '入库日期',
      },
      postingDate: {
        order: 2,
        cols: 6,
        label: '过账日期',
      },
      ...tradingPartyFields({
        kind: 'purchase',
        typeOrder: 3,
        idOrder: 4,
        idLabel: '对手(协作方)',
        resetOnType: { outsourcedWarehouseId: null },
        resetOnParty: { outsourcedWarehouseId: null },
      }),
      warehouseId: {
        order: 5,
        cols: 6,
        label: '默认入仓(可空)',
      },
      outsourcedWarehouseId: {
        order: 6,
        cols: 6,
        label: '默认外协仓(可空)',
      },
      remarks: { order: 7, label: '备注' },
      debitAccountId: {
        order: 100,
        cols: 6,
        required: true,
        label: '借方科目',
        hidden: true,
      },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目(未开票应付)',
        hidden: true,
      },
    },
    documentPreview: (presentation): DocumentPreviewConfig => ({
      label: presentation.label,
      docNoField: 'receiptNo',
      head: previewHead(presentation, {
        unhideAccounts: true,
      }),
      lineTables: [
        {
          title: '成品入库行',
          resource: 'purOutsourcedReceiptItems',
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
          parentIdField: 'receiptItemId',
          load: (receiptId, resolveReader) =>
            loadOutsourcedChildRows(receiptId, 'material', resolveReader),
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
            materialCode: materialCodeOverride({
              label: '材料',
            }),
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
          parentIdField: 'receiptItemId',
          load: (receiptId, resolveReader) =>
            loadOutsourcedChildRows(receiptId, 'byproduct', resolveReader),
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
    }),
  },
  purOutsourcedIssues: {
    label: '委外发料单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      issueNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      issueDate: {
        order: 1,
        cols: 6,
        required: true,
        label: '发料日期',
      },
      ...tradingPartyFields({
        kind: 'purchase',
        typeOrder: 2,
        idOrder: 3,
        idLabel: '对手(协作方)',
        resetOnType: { outsourcedWarehouseId: null },
        resetOnParty: { outsourcedWarehouseId: null },
      }),
      fromWarehouseId: {
        order: 4,
        cols: 6,
        label: '默认调出仓(可空)',
      },
      outsourcedWarehouseId: {
        order: 5,
        cols: 6,
        label: '默认外协仓(可空)',
      },
      remarks: { order: 6, label: '备注' },
    },
    documentPreview: (presentation): DocumentPreviewConfig => ({
      label: presentation.label,
      docNoField: 'issueNo',
      head: previewHead(presentation),
      lineTables: [
        {
          title: '发料条目',
          resource: 'purOutsourcedIssueItems',
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
            materialCode: materialCodeOverride({
              label: '材料',
              wide: true,
            }),
            unitName: UNIT_NAME_OVERRIDE,
            fromWarehouseId: { label: '调出仓' },
            outsourcedWarehouseId: { label: '外协仓' },
            baseQty: BASE_QTY_OVERRIDE,
            remarks: LINE_REMARK_OVERRIDE,
          },
        },
      ],
    }),
  },
  purReconciliations: {
    label: '采购对账单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: [
      'status',
      'createdById',
      'grossTotal',
      'baseGrossTotal',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      reconciliationNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      reconciliationType: {
        order: 1,
        cols: 6,
        required: true,
        edit: 'createOnly',
        label: '对账类型',
      },
      ...tradingPartyFields({
        kind: 'purchase',
        typeOrder: 2,
        idOrder: 3,
      }),
      postingDate: {
        order: 4,
        cols: 6,
        label: '过账日期',
        visible: (values) => values.reconciliationType === 'GIFT_SAMPLE',
      },
      remarks: { order: 6, label: '备注' },
      debitAccountId: {
        order: 100,
        cols: 6,
        required: true,
        label: '借方科目(未开票应付)',
        hidden: true,
      },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目',
        hidden: true,
      },
    },
  },
} satisfies Record<PurchaseDocumentResource, PresentationDefinition>

async function loadOutsourcedChildRows(
  receiptId: string,
  kind: 'material' | 'byproduct',
  resolveReader: DocumentPreviewReaderResolver,
): Promise<Row[]> {
  const items = await resolveReader('purOutsourcedReceiptItems').query({
    limit: 200,
    offset: 0,
    sort: { column: 'idx', direction: 'ascending' },
    filter: {
      receiptId: {
        kind: 'fk',
        op: 'in',
        values: [receiptId],
        labels: [],
      },
    },
  })
  const itemIds = items.results.map((row) => String(row.id))
  if (itemIds.length === 0) return []
  const resource =
    kind === 'material'
      ? 'purOutsourcedReceiptItemMaterials'
      : 'purOutsourcedReceiptItemByproducts'
  const result = await resolveReader(resource).query({
    limit: 200,
    offset: 0,
    sort: { column: 'idx', direction: 'ascending' },
    filter: {
      receiptItemId: {
        kind: 'fk',
        op: 'in',
        values: itemIds,
        labels: [],
      },
    },
  })
  return result.results
}

export function createPurchaseDocumentPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  return presentationFromDefinitions(binding, DEFINITIONS, '采购单据')
}
