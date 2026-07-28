/**
 * sales.order 打印所需 Meta（头+条目+物料/报价条目目标）。
 * 完整订单服务在工单 06；此处仅注册字段目录与装配依赖的 Meta 面。
 */
import type { ResourceMeta } from '../meta/types.ts'
import type { Registry } from '../meta/registry.ts'

function f(
  name: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name, apiName, dbColumn: name, type, label, ...opts }
}

const orderPartyOptions = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
]

const orderStatusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'CLOSED', label: '已关闭' },
  { value: 'VOIDED', label: '已作废' },
]

const orderTypeOptions = [
  { value: 'REGULAR', label: '常规订单' },
  { value: 'SAMPLE', label: '样品订单' },
]

export function salesOrderResourceMeta(): ResourceMeta {
  const company = 'basCompanies'
  const currency = 'basCurrencies'
  const user = 'sysUsers'
  const name = 'name'
  const companyRel = 'company'
  const currencyRel = 'currency'
  const createdRel = 'createdBy'
  const auditedRel = 'auditedBy'
  const discriminator = 'partyType'
  return {
    name: 'salOrders',
    permissionPrefix: 'sales.order',
    permissionLabel: '销售订单',
    table: 'sal_order',
    print: true,
    printHead: true,
    printLoops: [{ name: 'items', resource: 'salOrderItems' }],
    audit: { enabled: true },
    destroyMutation: 'destroySalOrder',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('order_no', 'orderNo', 'string', '订单号', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      f('order_date', 'orderDate', 'date', '订单日期', { filterable: true, sortable: true }),
      f('order_type', 'orderType', 'enum', '订单类型', {
        enumOptions: orderTypeOptions,
        filterable: true,
        sortable: true,
      }),
      f('party_type', 'partyType', 'enum', '对手类型(客户/内部公司)', {
        enumOptions: orderPartyOptions,
        filterable: true,
        sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        required: true,
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator,
          discriminatorType: 'enum',
          variants: [
            { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
            { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
          ],
        },
      }),
      f('exchange_rate', 'exchangeRate', 'decimal', '汇率(原币→本币)'),
      f('terms', 'terms', 'string', '交易条款(对客户,自由文本)', { filterable: true }),
      f('remarks', 'remarks', 'string', '订单备注(对内)', { filterable: true }),
      f('status', 'status', 'enum', '状态', {
        enumOptions: orderStatusOptions,
        filterable: true,
        sortable: true,
      }),
      f('audited_at', 'auditedAt', 'datetime', '审核时间', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: company, relation: companyRel, labelField: name },
      }),
      f('currency_id', 'currencyId', 'fk', '币种(原币)', {
        required: true,
        filterable: true,
        ref: { resource: currency, relation: currencyRel, labelField: name },
      }),
      f('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true,
        filterable: true,
        ref: { resource: user, relation: createdRel, labelField: name },
      }),
      f('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true,
        filterable: true,
        ref: { resource: user, relation: auditedRel, labelField: name },
      }),
      f('gross_total', 'grossTotal', 'decimal', '原币含税总额', { calculated: true }),
      f('base_gross_total', 'baseGrossTotal', 'decimal', '本币含税总额', { calculated: true }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'print', label: '打印', scope: 'row' },
      { key: 'export', label: '导出', scope: 'both' },
      { key: 'batch_print', label: '批量打印', scope: 'bulk' },
    ],
  }
}

export function salesOrderItemResourceMeta(): ResourceMeta {
  const orderRel = 'order'
  const companyRel = 'company'
  const materialRel = 'material'
  const unitRel = 'unit'
  const quoteRel = 'quotationItem'
  const name = 'name'
  const orderNo = 'orderNo'
  const materialCode = 'materialCode'
  const discriminator = 'partyType'
  return {
    name: 'salOrderItems',
    permissionPrefix: 'sales.order',
    permissionLabel: '销售订单',
    table: 'sal_order_item',
    audit: { enabled: true },
    destroyMutation: 'destroySalOrderItem',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号'),
      f('qty', 'qty', 'decimal', '数量'),
      f('base_qty', 'baseQty', 'decimal', '订购数量(物料默认单位)'),
      f('shipped_qty', 'shippedQty', 'decimal', '已发数量'),
      f('price', 'price', 'decimal', '原币含税单价'),
      f('amount', 'amount', 'decimal', '原币含税金额'),
      f('base_price', 'basePrice', 'decimal', '本币含税单价'),
      f('base_amount', 'baseAmount', 'decimal', '本币含税金额'),
      f('tax_rate', 'taxRate', 'decimal', '税率'),
      f('material_code', 'materialCode', 'string', '物料编号'),
      f('material_name', 'materialName', 'string', '物料名称'),
      f('material_spec', 'materialSpec', 'string', '规格'),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号'),
      f('unit_name', 'unitName', 'string', '单位名称'),
      f('remarks', 'remarks', 'string', '行备注'),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
      f('order_id', 'orderId', 'fk', '订单', {
        ref: { resource: 'salOrders', relation: orderRel, labelField: orderNo },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        ref: { resource: 'basCompanies', relation: companyRel, labelField: name },
      }),
      f('material_id', 'materialId', 'fk', '物料', {
        ref: { resource: 'invMaterials', relation: materialRel, labelField: name },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        ref: { resource: 'basUnits', relation: unitRel, labelField: name },
      }),
      f('quotation_item_id', 'quotationItemId', 'fk', '报价条目', {
        ref: { resource: 'salQuotationItems', relation: quoteRel, labelField: materialCode },
      }),
      f('order_date', 'orderDate', 'date', '订单日期', { calculated: true }),
      f('order_status', 'orderStatus', 'enum', '状态', {
        calculated: true,
        enumOptions: orderStatusOptions,
      }),
      f('party_type', 'partyType', 'enum', '对手类型', {
        calculated: true,
        enumOptions: orderPartyOptions,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        readonly: true,
        filterable: true,
        printRawId: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator,
          discriminatorType: 'enum',
          variants: [
            { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
            { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
          ],
        },
      }),
      f('currency_code', 'currencyCode', 'string', '币种', { calculated: true }),
      f('remaining_base_qty', 'remainingBaseQty', 'decimal', '未发数量', { calculated: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

export function invMaterialResourceMeta(): ResourceMeta {
  return {
    name: 'invMaterials',
    permissionPrefix: 'inv.material',
    permissionLabel: '物料',
    table: 'inv_material',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('code', 'code', 'string', '物料编号', { required: true, filterable: true, sortable: true }),
      f('name', 'name', 'string', '物料名称', { required: true, filterable: true, sortable: true }),
      f('spec', 'spec', 'string', '规格', { filterable: true }),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', { filterable: true }),
      f('active', 'active', 'boolean', '启用', { filterable: true }),
      f('is_customer_material', 'isCustomerMaterial', 'boolean', '客供料', { filterable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    audit: { enabled: true },
  }
}

export function salQuotationItemResourceMeta(): ResourceMeta {
  return {
    name: 'salQuotationItems',
    permissionPrefix: 'sales.quotation',
    permissionLabel: '销售报价',
    table: 'sal_quotation_item',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true }),
      f('idx', 'idx', 'integer', '行号'),
      f('pricing_mode', 'pricingMode', 'enum', '定价模式', {
        enumOptions: [
          { value: 'FIXED', label: '固定价' },
          { value: 'QTY_TIERED', label: '数量梯度' },
        ],
      }),
      f('price', 'price', 'decimal', '单价'),
      f('tax_rate', 'taxRate', 'decimal', '税率'),
      f('material_code', 'materialCode', 'string', '物料编号'),
      f('material_name', 'materialName', 'string', '物料名称'),
      f('material_spec', 'materialSpec', 'string', '规格'),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号'),
      f('unit_name', 'unitName', 'string', '单位'),
      f('remarks', 'remarks', 'string', '备注'),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

/** 注册 sales.order 打印装配依赖的 Meta（若尚未注册） */
export function registerSalesOrderPrintMetas(registry: Registry): void {
  if (!registry.get('invMaterials')) registry.register(invMaterialResourceMeta())
  if (!registry.get('salQuotationItems')) registry.register(salQuotationItemResourceMeta())
  if (!registry.get('salOrders')) registry.register(salesOrderResourceMeta())
  if (!registry.get('salOrderItems')) registry.register(salesOrderItemResourceMeta())
}
