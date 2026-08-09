import type { ResourceMeta } from '~/platform/meta/types.ts'

export const ORDER_FLOW_SOURCE_READ_PERMISSIONS = [
  'purchase.receipt:read',
  'purchase.outsourced_issue:read',
  'purchase.outsourced_receipt:read',
  'sales.delivery:read',
  'sales.return:read',
  'purchase.return:read',
  'purchase.outsourced_return:read',
] as const

const FLOW_TYPES = [
  { value: 'PURCHASE_RECEIPT', label: '采购入库' },
  { value: 'OUTSOURCED_ISSUE', label: '委外发料' },
  { value: 'OUTSOURCED_RECEIPT', label: '委外入库' },
  { value: 'SALES_DELIVERY', label: '销售发货' },
  { value: 'SALES_RETURN', label: '销售退货' },
  { value: 'PURCHASE_RETURN', label: '采购退货' },
  { value: 'OUTSOURCED_RETURN', label: '委外退货' },
]

const STATUS = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'VOIDED', label: '已作废' },
]

function f(
  name: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name, apiName, dbColumn: name, type, label, readonly: true, ...opts }
}

export function orderFlowItemMeta(): ResourceMeta {
  return {
    name: 'scmOrderFlowItems',
    classification: { presentation: 'none', interactive: false, note: '订单流只读投影' },
    permissionPrefix: 'base.order_flow',
    permissionLabel: '订单收发货历史',
    table: 'scm_order_flow_item',
    authz: { kind: 'company', readAnyOf: [...ORDER_FLOW_SOURCE_READ_PERMISSIONS] },
    fields: [
      f('id', 'id', 'string', '行标识(单据类型:来源行 id)', {
        filterable: true,
        sortable: true,
      }),
      f('flow_type', 'flowType', 'enum', '单据类型', {
        enumOptions: FLOW_TYPES,
        filterable: true,
        sortable: true,
      }),
      f('voucher_no', 'voucherNo', 'string', '单据编号', {
        filterable: true,
        sortable: true,
      }),
      f('voucher_date', 'voucherDate', 'date', '单据日期', {
        filterable: true,
        sortable: true,
      }),
      f('status', 'status', 'enum', '单据状态', {
        enumOptions: STATUS,
        filterable: true,
        sortable: true,
      }),
      f('qty', 'qty', 'decimal', '数量', { filterable: true, sortable: true }),
      f('material_code', 'materialCode', 'string', '物料编号', {
        filterable: true,
        sortable: true,
      }),
      f('material_name', 'materialName', 'string', '物料名称', {
        filterable: true,
        sortable: true,
      }),
      f('material_spec', 'materialSpec', 'string', '规格', {
        filterable: true,
        sortable: true,
      }),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', {
        filterable: true,
        sortable: true,
      }),
      f('unit_name', 'unitName', 'string', '单位名称', {
        filterable: true,
        sortable: true,
      }),
      f('order_id', 'orderId', 'uuid', '订单', { sortable: true }),
      f('order_item_id', 'orderItemId', 'uuid', '订单条目', { sortable: true }),
      f('company_id', 'companyId', 'uuid', '公司', { sortable: true }),
    ],
    actions: [],
    audit: { enabled: false },
  }
}
