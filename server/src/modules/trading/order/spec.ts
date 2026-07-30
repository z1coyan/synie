import type { TradingSide } from '../common.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

export interface OrderSideSpec {
  side: TradingSide
  prefix: string
  label: string
  headTable: string
  itemTable: string
  headResource: string
  itemResource: string
  itemOwnerType: string
  numberResource: string
  headDestroy: string
  itemDestroy: string
  auditMutation: string
  closeMutation: string
  voidMutation: string
  nonRegularType: string
  nonRegularSetting: string
  allowedParty: ReadonlySet<string>
  projectionColumn: string
}

const SPECS: Record<TradingSide, OrderSideSpec> = {
  sales: {
    side: 'sales',
    prefix: 'sales.order',
    label: '销售订单',
    headTable: 'sal_order',
    itemTable: 'sal_order_item',
    headResource: 'salOrders',
    itemResource: 'salOrderItems',
    itemOwnerType: 'sal_order_item',
    numberResource: 'sales.order',
    headDestroy: 'destroySalOrder',
    itemDestroy: 'destroySalOrderItem',
    auditMutation: 'auditSalOrder',
    closeMutation: 'closeSalOrder',
    voidMutation: 'voidSalOrder',
    nonRegularType: 'SAMPLE',
    nonRegularSetting: 'sample_item_max_qty',
    allowedParty: new Set(['customer', 'company']),
    projectionColumn: 'shipped_qty',
  },
  purchase: {
    side: 'purchase',
    prefix: 'purchase.order',
    label: '采购订单',
    headTable: 'pur_order',
    itemTable: 'pur_order_item',
    headResource: 'purOrders',
    itemResource: 'purOrderItems',
    itemOwnerType: 'pur_order_item',
    numberResource: 'purchase.order',
    headDestroy: 'destroyPurOrder',
    itemDestroy: 'destroyPurOrderItem',
    auditMutation: 'auditPurOrder',
    closeMutation: 'closePurOrder',
    voidMutation: 'voidPurOrder',
    nonRegularType: 'SPOT',
    nonRegularSetting: 'spot_item_max_qty',
    allowedParty: new Set(['supplier', 'company']),
    projectionColumn: 'received_qty',
  },
}

export function orderSpec(side: TradingSide): OrderSideSpec {
  return SPECS[side]
}

const PARTY_OPTIONS = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
]
const STATUS_OPTIONS = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'CLOSED', label: '已关闭' },
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

export function orderHeadMeta(side: TradingSide): ResourceMeta {
  const spec = orderSpec(side)
  const orderTypes =
    side === 'sales'
      ? [
          { value: 'REGULAR', label: '常规订单' },
          { value: 'SAMPLE', label: '样品订单' },
        ]
      : [
          { value: 'REGULAR', label: '常规订单' },
          { value: 'SPOT', label: '零星订单' },
        ]
  const partyLabel =
    side === 'sales' ? '对手类型(客户/内部公司)' : '对手类型(供应商/内部公司)'
  const termsLabel =
    side === 'sales' ? '交易条款(对客户,自由文本)' : '交易条款(对供应商,自由文本)'
  const variants =
    side === 'sales'
      ? [
          { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
          { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
        ]
      : [
          { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
          { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
        ]
  const fields: ResourceMeta['fields'] = [
    f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
    f('order_no', 'orderNo', 'string', '订单号', { required: true, filterable: true, sortable: true }),
    f('order_date', 'orderDate', 'date', '订单日期', { required: true, filterable: true, sortable: true }),
    f('order_type', 'orderType', 'enum', '订单类型', {
      required: true,
      enumOptions: orderTypes,
      filterable: true,
      sortable: true,
    }),
  ]
  if (side === 'purchase') {
    fields.push(
      f('is_outsourced', 'isOutsourced', 'boolean', '委外标记', {
        filterable: true,
        sortable: true,
      }),
    )
  }
  fields.push(
    f('party_type', 'partyType', 'enum', partyLabel, {
      required: true,
      enumOptions: PARTY_OPTIONS,
      filterable: true,
      sortable: true,
    }),
    f('party_id', 'partyId', 'fk', '对手', {
      required: true,
      filterable: true,
      ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType',
        discriminatorType: 'enum',
        variants,
      },
    }),
    f('exchange_rate', 'exchangeRate', 'decimal', '汇率(原币→本币)', {
      filterable: true,
      sortable: true,
    }),
    f('terms', 'terms', 'string', termsLabel, { filterable: true, sortable: true }),
    f('remarks', 'remarks', 'string', '订单备注(对内)', { filterable: true, sortable: true }),
    f('status', 'status', 'enum', '状态', {
      readonly: true,
      enumOptions: STATUS_OPTIONS,
      filterable: true,
      sortable: true,
    }),
    f('audited_at', 'auditedAt', 'datetime', '审核时间', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
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
      ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
    }),
    f('currency_id', 'currencyId', 'fk', '币种(原币)', {
      required: true,
      filterable: true,
      ref: { resource: 'basCurrencies', relation: 'currency', labelField: 'name' },
    }),
    f('created_by_id', 'createdById', 'fk', '录入人', {
      readonly: true,
      filterable: true,
      ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
    }),
    f('audited_by_id', 'auditedById', 'fk', '审核人', {
      readonly: true,
      filterable: true,
      ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
    }),
    f('gross_total', 'grossTotal', 'decimal', '原币含税总额(行原币含税金额合计)', {
      readonly: true,
      calculated: true,
    }),
    f('base_gross_total', 'baseGrossTotal', 'decimal', '本币含税总额(行本币含税金额合计)', {
      readonly: true,
      calculated: true,
    }),
  )
  const actions: ResourceMeta['actions'] = [
    { key: 'read', label: '查看', scope: 'both' },
    { key: 'create', label: '新增', scope: 'both' },
    { key: 'update', label: '编辑', scope: 'row' },
    { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    { key: 'audit', label: '审核', scope: 'row'},
    { key: 'close', label: '关闭', scope: 'row'},
    { key: 'void', label: '作废', scope: 'row', isDanger: true },
  ]
  if (side === 'sales') {
    actions.push(
      { key: 'print', label: '打印', scope: 'row' },
      { key: 'export', label: '导出', scope: 'both' },
      { key: 'batch_print', label: '批量打印', scope: 'bulk' },
    )
  }
  return {
    name: spec.headResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.headTable,
    fields,
    actions,
    print: side === 'sales',
    printHead: true,
    printLoops: [{ name: 'items', resource: spec.itemResource }],
    audit: { enabled: true },
  }
}

export function orderItemMeta(side: TradingSide): ResourceMeta {
  const spec = orderSpec(side)
  const quoteResource = side === 'sales' ? 'salQuotationItems' : 'purQuotationItems'
  const partyLabel =
    side === 'sales' ? '对手类型(客户/内部公司)' : '对手类型(供应商/内部公司)'
  const variants =
    side === 'sales'
      ? [
          { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
          { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
        ]
      : [
          { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
          { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
        ]
  const projName = side === 'sales' ? 'shipped_qty' : 'received_qty'
  const projApi = side === 'sales' ? 'shippedQty' : 'receivedQty'
  const projLabel =
    side === 'sales' ? '已发数量(物料默认单位,系统维护)' : '已收数量(物料默认单位,系统维护)'
  const fields: ResourceMeta['fields'] = [
    f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
    f('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
    f('qty', 'qty', 'decimal', '数量', { required: true, filterable: true, sortable: true }),
    f('base_qty', 'baseQty', 'decimal', '订购数量(物料默认单位,系统折算)', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f(projName, projApi, 'decimal', projLabel, { readonly: true, filterable: true, sortable: true }),
    f('price', 'price', 'decimal', '原币含税单价', { filterable: true, sortable: true }),
    f('amount', 'amount', 'decimal', '原币含税金额(系统算:数量×原币单价)', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('base_price', 'basePrice', 'decimal', '本币含税单价(系统算:原币单价×汇率,4位,仅展示参考)', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('base_amount', 'baseAmount', 'decimal', '本币含税金额(系统算:原币金额×汇率)', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('tax_rate', 'taxRate', 'decimal', '税率(小数,如 0.13)', {
      required: true,
      filterable: true,
      sortable: true,
    }),
    f('material_code', 'materialCode', 'string', '物料编号', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('material_name', 'materialName', 'string', '物料名称', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('material_spec', 'materialSpec', 'string', '规格', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('customer_part_no', 'customerPartNo', 'string', '客户料号', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('unit_name', 'unitName', 'string', '单位名称', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
  ]
  if (side === 'purchase') {
    fields.push(
      f('demand_date', 'demandDate', 'date', '需求日(来自履约需求行,可空)', {
        filterable: true,
        sortable: true,
      }),
    )
  }
  fields.push(
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
    f('order_id', 'orderId', 'fk', '订单', {
      required: true,
      createOnly: true,
      filterable: true,
      ref: { resource: spec.headResource, relation: 'order', labelField: 'orderNo' },
    }),
    f('company_id', 'companyId', 'fk', '公司', {
      readonly: true,
      filterable: true,
      ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
    }),
    f('material_id', 'materialId', 'fk', '物料', {
      required: true,
      filterable: true,
      ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
    }),
    f('unit_id', 'unitId', 'fk', '单位', {
      required: true,
      filterable: true,
      ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
    }),
    f('quotation_item_id', 'quotationItemId', 'fk', '报价条目', {
      filterable: true,
      ref: { resource: quoteResource, relation: 'quotationItem', labelField: 'materialCode' },
    }),
  )
  if (side === 'purchase') {
    fields.push(
      f('bom_id', 'bomId', 'fk', '成品 BOM(留痕,限条目物料自身)', {
        filterable: true,
        ref: { resource: 'mfgBoms', relation: 'bom', labelField: 'code' },
      }),
      f('demand_line_id', 'demandLineId', 'fk', '来源履约需求行', {
        filterable: true,
        ref: { resource: 'mfgDemandItems', relation: 'demandLine', labelField: 'materialCode' },
      }),
    )
  }
  fields.push(
    f('order_date', 'orderDate', 'date', '订单日期', {
      readonly: true,
      calculated: true,
      filterable: true,
      sortable: true,
    }),
    f('order_status', 'orderStatus', 'enum', '状态', {
      readonly: true,
      calculated: true,
      enumOptions: STATUS_OPTIONS,
      filterable: true,
      sortable: true,
    }),
  )
  if (side === 'purchase') {
    fields.push(
      f('order_is_outsourced', 'orderIsOutsourced', 'boolean', '委外订单', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
    )
  }
  fields.push(
    f('party_type', 'partyType', 'enum', partyLabel, {
      readonly: true,
      calculated: true,
      enumOptions: PARTY_OPTIONS,
      filterable: true,
      sortable: true,
    }),
    f('party_id', 'partyId', 'fk', '对手', {
      readonly: true,
      filterable: true,
      printRawId: true,
      ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants },
    }),
    f('currency_code', 'currencyCode', 'string', '币种', {
      readonly: true,
      calculated: true,
      filterable: true,
      sortable: true,
    }),
    f('remaining_base_qty', 'remainingBaseQty', 'decimal', side === 'sales' ? '未发数量(物料默认单位)' : '未收数量(物料默认单位)', {
      readonly: true,
      calculated: true,
      filterable: true,
      sortable: true,
    }),
  )
  return {
    name: spec.itemResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.itemTable,
    fields,
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },
  }
}

export function orderMaterialMeta(): ResourceMeta {
  return {
    name: 'purOrderItemMaterials',
    permissionPrefix: 'purchase.order',
    permissionLabel: '采购订单',
    table: 'pur_order_item_material',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('quantity', 'quantity', 'decimal', '数量', { required: true, filterable: true, sortable: true }),
      f('issued_qty', 'issuedQty', 'decimal', '已发料量(材料默认单位,系统维护)', { readonly: true, filterable: true, sortable: true }),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('order_item_id', 'orderItemId', 'fk', '订单条目', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'purOrderItems', relation: 'orderItem', labelField: 'materialCode' },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('material_id', 'materialId', 'fk', '材料', {
        required: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
      f('order_no', 'orderNo', 'string', '订单号', { readonly: true, calculated: true, filterable: true, sortable: true }),
      f('order_status', 'orderStatus', 'enum', '订单状态', {
        readonly: true,
        calculated: true,
        enumOptions: STATUS_OPTIONS,
        filterable: true,
        sortable: true,
      }),
      f('order_is_outsourced', 'orderIsOutsourced', 'boolean', '委外订单', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      f('party_type', 'partyType', 'enum', '对手类型(供应商/内部公司)', {
        readonly: true,
        calculated: true,
        enumOptions: PARTY_OPTIONS,
        filterable: true,
        sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        readonly: true,
        filterable: true,
        printRawId: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: 'partyType',
          discriminatorType: 'enum',
          variants: [
            { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
            { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
          ],
        },
      }),
      f('remaining_issue_qty', 'remainingIssueQty', 'decimal', '剩余可发料量(材料默认单位)', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function orderByproductMeta(): ResourceMeta {
  return {
    name: 'purOrderItemByproducts',
    permissionPrefix: 'purchase.order',
    permissionLabel: '采购订单',
    table: 'pur_order_item_byproduct',
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('quantity', 'quantity', 'decimal', '数量', { required: true, filterable: true, sortable: true }),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('order_item_id', 'orderItemId', 'fk', '订单条目', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'purOrderItems', relation: 'orderItem', labelField: 'materialCode' },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('material_id', 'materialId', 'fk', '材料', {
        required: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}
