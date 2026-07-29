import type { TradingSide } from '../common.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

export interface FulfillmentSideSpec {
  side: TradingSide
  label: string
  itemLabel: string
  prefix: string
  headTable: string
  itemTable: string
  orderTable: string
  orderItemTable: string
  orderProjection: string
  headOwnerType: string
  itemOwnerType: string
  voucherType: string
  numberResource: string
  allowedParty: ReadonlySet<string>
  requiredRoleSide: 'debit' | 'credit'
  requiredRole: string
  stockDirection: number
  numberCol: string
  dateCol: string
  parentCol: string
  headResource: string
  itemResource: string
  numberApi: string
  dateApi: string
  parentApi: string
  statusApi: string
  destroyHead: string
  destroyItem: string
  auditMutation: string
  voidMutation: string
}

export function fulfillmentSpec(side: TradingSide): FulfillmentSideSpec {
  if (side === 'sales') {
    return {
      side: 'sales',
      label: '销售发货单',
      itemLabel: '销售发货条目',
      prefix: 'sales.delivery',
      headTable: 'sal_delivery',
      itemTable: 'sal_delivery_item',
      orderTable: 'sal_order',
      orderItemTable: 'sal_order_item',
      orderProjection: 'shipped_qty',
      headOwnerType: 'sal_delivery',
      itemOwnerType: 'sal_delivery_item',
      voucherType: 'sales.delivery',
      numberResource: 'sales.delivery',
      allowedParty: new Set(['customer', 'company']),
      requiredRoleSide: 'debit',
      requiredRole: 'unbilled_receivable',
      stockDirection: -1,
      numberCol: 'delivery_no',
      dateCol: 'delivery_date',
      parentCol: 'delivery_id',
      headResource: 'salDeliveries',
      itemResource: 'salDeliveryItems',
      numberApi: 'deliveryNo',
      dateApi: 'deliveryDate',
      parentApi: 'deliveryId',
      statusApi: 'deliveryStatus',
      destroyHead: 'destroySalDelivery',
      destroyItem: 'destroySalDeliveryItem',
      auditMutation: 'auditSalDelivery',
      voidMutation: 'voidSalDelivery',
    }
  }
  return {
    side: 'purchase',
    label: '采购入库单',
    itemLabel: '采购入库条目',
    prefix: 'purchase.receipt',
    headTable: 'pur_receipt',
    itemTable: 'pur_receipt_item',
    orderTable: 'pur_order',
    orderItemTable: 'pur_order_item',
    orderProjection: 'received_qty',
    headOwnerType: 'pur_receipt',
    itemOwnerType: 'pur_receipt_item',
    voucherType: 'purchase.receipt',
    numberResource: 'purchase.receipt',
    allowedParty: new Set(['supplier', 'company']),
    requiredRoleSide: 'credit',
    requiredRole: 'unbilled_payable',
    stockDirection: 1,
    numberCol: 'receipt_no',
    dateCol: 'receipt_date',
    parentCol: 'receipt_id',
    headResource: 'purReceipts',
    itemResource: 'purReceiptItems',
    numberApi: 'receiptNo',
    dateApi: 'receiptDate',
    parentApi: 'receiptId',
    statusApi: 'receiptStatus',
    destroyHead: 'destroyPurReceipt',
    destroyItem: 'destroyPurReceiptItem',
    auditMutation: 'auditPurReceipt',
    voidMutation: 'voidPurReceipt',
  }
}

const PARTY = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
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
  return { name, apiName, dbColumn: name, type, label, ...opts }
}

export function fulfillmentHeadMeta(side: TradingSide): ResourceMeta {
  const spec = fulfillmentSpec(side)
  const sales = side === 'sales'
  const variants = sales
    ? [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
      ]
    : [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
      ]
  const actions: ResourceMeta['actions'] = [
    { key: 'read', label: '查看', scope: 'both' },
    { key: 'create', label: '新增', scope: 'both' },
    { key: 'update', label: '编辑', scope: 'row' },
    { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    { key: 'audit', label: '审核', scope: 'row', mutation: spec.auditMutation },
    { key: 'void', label: '作废', scope: 'row', mutation: spec.voidMutation, isDanger: true },
  ]
  if (sales) {
    actions.push(
      { key: 'print', label: '打印', scope: 'row' },
      { key: 'export', label: '导出', scope: 'both' },
      { key: 'batch_print', label: '批量打印', scope: 'bulk' },
    )
  }
  const printLoops: ResourceMeta['printLoops'] = [{ name: 'items', resource: spec.itemResource }]
  if (sales) printLoops.push({ name: 'pack_lines', resource: 'salDeliveryPackLines' })
  return {
    name: spec.headResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.headTable,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f(spec.numberCol, spec.numberApi, 'string', sales ? '发货单号' : '入库单号', {
        required: true, filterable: true, sortable: true,
      }),
      f(spec.dateCol, spec.dateApi, 'date', sales ? '发货日期(库存分录业务日)' : '入库日期(库存分录业务日)', {
        required: true, filterable: true, sortable: true,
      }),
      f('posting_date', 'postingDate', 'date', '过账日期(总账;有金额审核时必填)', {
        filterable: true, sortable: true,
      }),
      f('party_type', 'partyType', 'enum', sales ? '对手类型' : '对手类型(供应商/内部公司)', {
        required: true, enumOptions: PARTY, filterable: true, sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        required: true, filterable: true,
        ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants },
      }),
      f('remarks', 'remarks', 'string', '备注(对内;可带入库存分录)', { filterable: true, sortable: true }),
      f('status', 'status', 'enum', '状态', {
        readonly: true, enumOptions: STATUS, filterable: true, sortable: true,
      }),
      f('audited_at', 'auditedAt', 'datetime', '审核时间', { readonly: true, filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('warehouse_id', 'warehouseId', 'fk', '默认仓库(可空,仅新建行预填)', {
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      f('debit_account_id', 'debitAccountId', 'fk', sales ? '借方科目(未开票应收;草稿必填)' : '借方科目(自选:存货/费用等;草稿必填)', {
        required: true, filterable: true,
        ref: { resource: 'basAccounts', relation: 'debitAccount', labelField: 'name' },
      }),
      f('credit_account_id', 'creditAccountId', 'fk', sales ? '贷方科目(草稿必填)' : '贷方科目(未开票应付;草稿必填)', {
        required: true, filterable: true,
        ref: { resource: 'basAccounts', relation: 'creditAccount', labelField: 'name' },
      }),
      f('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      f('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions,
    print: sales,
    printHead: true,
    printLoops,
    audit: { enabled: true },
    destroyMutation: spec.destroyHead,
  }
}

export function fulfillmentItemMeta(side: TradingSide): ResourceMeta {
  const spec = fulfillmentSpec(side)
  const sales = side === 'sales'
  const variants = sales
    ? [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
      ]
    : [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
      ]
  return {
    name: spec.itemResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.itemTable,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      f('qty', 'qty', 'decimal', '录入数量', { required: true, filterable: true, sortable: true }),
      f('base_qty', 'baseQty', 'decimal', '折算数量(物料默认单位,6 位)', { readonly: true, filterable: true, sortable: true }),
      f('material_code', 'materialCode', 'string', '物料编号', { readonly: true, filterable: true, sortable: true }),
      f('material_name', 'materialName', 'string', '物料名称', { readonly: true, filterable: true, sortable: true }),
      f('material_spec', 'materialSpec', 'string', '规格', { readonly: true, filterable: true, sortable: true }),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', { readonly: true, filterable: true, sortable: true }),
      f('unit_name', 'unitName', 'string', '单位名称', { readonly: true, filterable: true, sortable: true }),
      f('order_no', 'orderNo', 'string', '订单号', { readonly: true, filterable: true, sortable: true }),
      f('order_qty', 'orderQty', 'decimal', '订购数量(订单行单位)', { readonly: true, filterable: true, sortable: true }),
      f('order_base_qty', 'orderBaseQty', 'decimal', '订购数量(默认单位)', { readonly: true, filterable: true, sortable: true }),
      f('order_unit_name', 'orderUnitName', 'string', '订单行单位名称', { readonly: true, filterable: true, sortable: true }),
      f('order_price', 'orderPrice', 'decimal', '原币含税单价', { readonly: true, filterable: true, sortable: true }),
      f('order_amount', 'orderAmount', 'decimal', '原币含税金额', { readonly: true, filterable: true, sortable: true }),
      f('order_base_price', 'orderBasePrice', 'decimal', '本币含税单价', { readonly: true, filterable: true, sortable: true }),
      f('order_base_amount', 'orderBaseAmount', 'decimal', '本币含税金额', { readonly: true, filterable: true, sortable: true }),
      f('order_tax_rate', 'orderTaxRate', 'decimal', '税率', { readonly: true, filterable: true, sortable: true }),
      f('order_currency_code', 'orderCurrencyCode', 'string', '订单原币代码', { readonly: true, filterable: true, sortable: true }),
      f('reconciled_qty', 'reconciledQty', 'decimal', sales ? '已对账数量(默认单位;由销售对账单生效/回退同步)' : '已对账数量(默认单位;由采购对账单生效/回退同步)', {
        readonly: true, filterable: true, sortable: true,
      }),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f(spec.parentCol, spec.parentApi, 'fk', sales ? '销售发货单' : '采购入库单', {
        required: true, createOnly: true, filterable: true,
        ref: { resource: spec.headResource, relation: sales ? 'delivery' : 'receipt', labelField: spec.numberApi },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('order_item_id', 'orderItemId', 'fk', '订单条目', {
        required: true, filterable: true,
        ref: {
          resource: sales ? 'salOrderItems' : 'purOrderItems',
          relation: 'orderItem',
          labelField: 'materialCode',
        },
      }),
      f('material_id', 'materialId', 'fk', '物料', {
        required: true, filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        required: true, filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
      f('warehouse_id', 'warehouseId', 'fk', sales ? '出库仓库' : '入库仓库', {
        required: true, filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      f(spec.numberCol, spec.numberApi, 'string', sales ? '发货单号' : '入库单号', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
      f(spec.dateCol, spec.dateApi, 'date', sales ? '发货日期' : '入库日期', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
      f(sales ? 'delivery_status' : 'receipt_status', spec.statusApi, 'enum', sales ? '发货单状态' : '入库单状态', {
        readonly: true, calculated: true, enumOptions: STATUS, filterable: true, sortable: true,
      }),
      f('party_type', 'partyType', 'enum', sales ? '对手类型' : '对手类型(供应商/内部公司)', {
        readonly: true, calculated: true, enumOptions: PARTY, filterable: true, sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        readonly: true, filterable: true, printRawId: true,
        ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants },
      }),
      f('remaining_reconcilable_qty', 'remainingReconcilableQty', 'decimal', '剩余可对账量(默认单位)', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },
    destroyMutation: spec.destroyItem,
  }
}

/**
 * 列表查询用 Meta（不注册进 Registry）：销售发货条目可按来源订单类型筛选候选池，
 * 对齐 Go itemQueryResourceMeta，不暴露到 Grid 契约。
 */
export function fulfillmentItemListMeta(side: TradingSide): ResourceMeta {
  const base = fulfillmentItemMeta(side)
  if (side !== 'sales') return base
  return {
    ...base,
    fields: [
      ...base.fields,
      f('order_type', 'orderType', 'enum', '来源订单类型', {
        filterable: true,
        enumOptions: [
          { value: 'REGULAR', label: '常规' },
          { value: 'SAMPLE', label: '样品' },
        ],
      }),
    ],
  }
}

export function packBoxMeta(): ResourceMeta {
  return {
    name: 'salDeliveryPackBoxes',
    permissionPrefix: 'sales.delivery',
    permissionLabel: '销售发货单',
    table: 'sal_delivery_pack_box',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('box_no', 'boxNo', 'integer', '箱号(系统生成)', { readonly: true, filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('delivery_id', 'deliveryId', 'fk', '发货单', {
        required: true, createOnly: true, filterable: true,
        ref: { resource: 'salDeliveries', relation: 'delivery', labelField: 'deliveryNo' },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },
    destroyMutation: 'destroySalDeliveryPackBox',
  }
}

export function packLineMeta(): ResourceMeta {
  return {
    name: 'salDeliveryPackLines',
    permissionPrefix: 'sales.delivery',
    permissionLabel: '销售发货单',
    table: 'sal_delivery_pack_line',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      f('pack_box_id', 'packBoxId', 'fk', '装箱箱', {
        required: true, filterable: true,
        ref: { resource: 'salDeliveryPackBoxes', relation: 'box', labelField: 'boxNo' },
      }),
      f('qty', 'qty', 'decimal', '数量', { required: true, filterable: true, sortable: true }),
      f('base_qty', 'baseQty', 'decimal', '折算数量(默认单位)', { readonly: true, filterable: true, sortable: true }),
      f('material_code', 'materialCode', 'string', '物料编号', { readonly: true, filterable: true, sortable: true }),
      f('material_name', 'materialName', 'string', '物料名称', { readonly: true, filterable: true, sortable: true }),
      f('material_spec', 'materialSpec', 'string', '规格', { readonly: true, filterable: true, sortable: true }),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', { readonly: true, filterable: true, sortable: true }),
      f('unit_name', 'unitName', 'string', '单位名称', { readonly: true, filterable: true, sortable: true }),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('delivery_id', 'deliveryId', 'fk', '发货单', {
        required: true, createOnly: true, filterable: true,
        ref: { resource: 'salDeliveries', relation: 'delivery', labelField: 'deliveryNo' },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('material_id', 'materialId', 'fk', '物料', {
        required: true, filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        required: true, filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },
    destroyMutation: 'destroySalDeliveryPackLine',
  }
}
