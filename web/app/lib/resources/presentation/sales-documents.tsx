/**
 * 销售单据 Presentation Extension。
 *
 * Drawer 与销售发货 document preview 共置；审核配置继续由对应业务 drawer
 * module 导出，避免把业务交互重新抬回全局 registry。
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
import type { PresentationExtension } from './types'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'

export const SALES_DOCUMENT_RESOURCES = [
  'salOrders',
  'salQuotations',
  'salDeliveries',
  'salReturns',
  'salReconciliations',
] as const

export type SalesDocumentResource = (typeof SALES_DOCUMENT_RESOURCES)[number]

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
  salOrders: {
    label: '销售订单',
    contentClassName: 'w-full lg:w-[800px]',
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
        kind: 'sales',
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
        '对客户展示的交易条款,如交付、付款、验收约定',
        7,
      ),
    },
  },
  salQuotations: {
    label: '销售报价单',
    contentClassName: 'w-full lg:w-[800px]',
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
        kind: 'sales',
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
        '对客户展示的报价条款,如付款、交付、有效条件约定',
        7,
      ),
    },
  },
  salDeliveries: {
    label: '销售发货单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      deliveryNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      deliveryDate: { order: 1, cols: 6, required: true },
      postingDate: {
        order: 2,
        cols: 6,
        label: '过账日期',
      },
      ...tradingPartyFields({
        kind: 'sales',
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
        label: '借方科目(未开票应收)',
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
    documentPreview: (presentation) => ({
      label: presentation.label,
      docNoField: 'deliveryNo',
      head: previewHead(presentation, {
        unhideAccounts: true,
      }),
      lineTables: [
        {
          title: '发货条目',
          resource: 'salDeliveryItems',
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
    }),
  },
  salReturns: {
    label: '销售退货单',
    contentClassName: 'w-full lg:w-[880px]',
    exclude: AUDIT_TRAIL_EXCLUDE,
    fields: {
      companyId: {
        required: true,
        order: -1,
        cols: 6,
        edit: 'createOnly',
      },
      returnNo: {
        order: 0,
        cols: 6,
        placeholder: '保存后自动编号',
      },
      returnDate: { order: 1, cols: 6, required: true },
      postingDate: {
        order: 2,
        cols: 6,
        label: '过账日期',
      },
      ...tradingPartyFields({
        kind: 'sales',
        typeOrder: 3,
        idOrder: 4,
      }),
      currencyId: {
        order: 5,
        cols: 6,
        label: '原币(源单行须与订单快照币种一致)',
        remote: {
          filterState: { active: { kind: 'bool', eq: true } },
        },
      },
      exchangeRate: {
        order: 6,
        cols: 6,
        label: '汇率(默认 1)',
      },
      warehouseId: {
        order: 7,
        cols: 6,
        label: '默认仓库(可空)',
      },
      remarks: { order: 8, label: '备注' },
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
        label: '贷方科目(未开票应收)',
        hidden: true,
      },
    },
  },
  salReconciliations: {
    label: '销售对账单',
    contentClassName: 'w-full lg:w-[880px]',
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
        kind: 'sales',
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
        label: '借方科目',
        hidden: true,
      },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目(未开票应收)',
        hidden: true,
      },
    },
  },
} satisfies Record<SalesDocumentResource, PresentationDefinition>

export function createSalesDocumentPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  return presentationFromDefinitions(binding, DEFINITIONS, '销售单据')
}
