import type { TradingSide } from '../common.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

export interface QuotationSideSpec {
  side: TradingSide
  prefix: string
  label: string
  headTable: string
  itemTable: string
  tierTable: string
  headResource: string
  itemResource: string
  tierResource: string
  headAudit: string
  itemAudit: string
  tierAudit: string
  headDestroy: string
  itemDestroy: string
  tierDestroy: string
  auditMutation: string
  voidMutation: string
  partyLabel: string
  termsLabel: string
  allowedParty: ReadonlySet<string>
  partyVariants: Array<{ value: string; resource: string; label: string }>
  customerMaterialGuard: boolean
}

const SPECS: Record<TradingSide, QuotationSideSpec> = {
  sales: {
    side: 'sales',
    prefix: 'sales.quotation',
    label: '销售报价单',
    headTable: 'sal_quotation',
    itemTable: 'sal_quotation_item',
    tierTable: 'sal_quotation_tier',
    headResource: 'salQuotations',
    itemResource: 'salQuotationItems',
    tierResource: 'salQuotationTiers',
    headAudit: 'sal_quotation',
    itemAudit: 'sal_quotation_item',
    tierAudit: 'sal_quotation_tier',
    headDestroy: 'destroySalQuotation',
    itemDestroy: 'destroySalQuotationItem',
    tierDestroy: 'destroySalQuotationTier',
    auditMutation: 'auditSalQuotation',
    voidMutation: 'voidSalQuotation',
    partyLabel: '对手类型(客户/内部公司)',
    termsLabel: '报价条款(对客户,自由文本)',
    allowedParty: new Set(['customer', 'company']),
    partyVariants: [
      { value: 'COMPANY', resource: 'basCompanies', label: '内部公司' },
      { value: 'CUSTOMER', resource: 'salCustomers', label: '客户' },
    ],
    customerMaterialGuard: true,
  },
  purchase: {
    side: 'purchase',
    prefix: 'purchase.quotation',
    label: '采购报价单',
    headTable: 'pur_quotation',
    itemTable: 'pur_quotation_item',
    tierTable: 'pur_quotation_tier',
    headResource: 'purQuotations',
    itemResource: 'purQuotationItems',
    tierResource: 'purQuotationTiers',
    headAudit: 'pur_quotation',
    itemAudit: 'pur_quotation_item',
    tierAudit: 'pur_quotation_tier',
    headDestroy: 'destroyPurQuotation',
    itemDestroy: 'destroyPurQuotationItem',
    tierDestroy: 'destroyPurQuotationTier',
    auditMutation: 'auditPurQuotation',
    voidMutation: 'voidPurQuotation',
    partyLabel: '对手类型(供应商/内部公司)',
    termsLabel: '报价条款(对供应商,自由文本)',
    allowedParty: new Set(['supplier', 'company']),
    partyVariants: [
      { value: 'COMPANY', resource: 'basCompanies', label: '内部公司' },
      { value: 'SUPPLIER', resource: 'purSuppliers', label: '供应商' },
    ],
    customerMaterialGuard: false,
  },
}

export function quotationSpec(side: TradingSide): QuotationSideSpec {
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
  { value: 'VOIDED', label: '已作废' },
]

const PRICING_OPTIONS = [
  { value: 'FIXED', label: '固定价' },
  { value: 'QTY_TIERED', label: '数量梯度' },
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

export function quotationHeadMeta(side: TradingSide): ResourceMeta {
  const spec = quotationSpec(side)
  const company = 'basCompanies'
  const currency = 'basCurrencies'
  const user = 'sysUsers'
  const name = 'name'
  const discriminator = 'partyType'
  const discriminatorType = 'enum'
  return {
    name: spec.headResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.headTable,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('quotation_no', 'quotationNo', 'string', '报价单号', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      f('quotation_date', 'quotationDate', 'date', '报价日期', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      f('valid_until', 'validUntil', 'date', '报价截止(含当日)', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      f('party_type', 'partyType', 'enum', spec.partyLabel, {
        required: true,
        enumOptions: PARTY_OPTIONS,
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
          discriminatorType,
          variants: spec.partyVariants.map((v) => ({
            value: v.value,
            resource: v.resource,
            labelField: 'name',
            label: v.label,
          })),
        },
      }),
      f('terms', 'terms', 'string', spec.termsLabel, { filterable: true, sortable: true }),
      f('remarks', 'remarks', 'string', '报价备注(对内)', { filterable: true, sortable: true }),
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
        ref: { resource: company, relation: 'company', labelField: name },
      }),
      f('currency_id', 'currencyId', 'fk', '币种', {
        required: true,
        filterable: true,
        ref: { resource: currency, relation: 'currency', labelField: name },
      }),
      f('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true,
        filterable: true,
        ref: { resource: user, relation: 'createdBy', labelField: name },
      }),
      f('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true,
        filterable: true,
        ref: { resource: user, relation: 'auditedBy', labelField: name },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'audit', label: '审核', scope: 'row'},
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    print: true,
    printHead: true,
    printLoops: [{ name: 'items', resource: spec.itemResource }],
    audit: { enabled: true },
  }
}

export function quotationItemMeta(side: TradingSide): ResourceMeta {
  const spec = quotationSpec(side)
  const discriminator = 'partyType'
  const discriminatorType = 'enum'
  return {
    name: spec.itemResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.itemTable,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      f('pricing_mode', 'pricingMode', 'enum', '定价模式', {
        required: true,
        enumOptions: PRICING_OPTIONS,
        filterable: true,
        sortable: true,
      }),
      f('price', 'price', 'decimal', '含税单价(固定价模式)', { filterable: true, sortable: true }),
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
      f('quotation_id', 'quotationId', 'fk', '报价单', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: {
          resource: spec.headResource,
          relation: 'quotation',
          labelField: 'quotationNo',
        },
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
      f('tier_count', 'tierCount', 'integer', '价格档数', {
        readonly: true,
        calculated: true,
      }),
      f('quotation_date', 'quotationDate', 'date', '报价日期', {
        readonly: true,
        filterable: true,
        sortable: true,
        calculated: true,
      }),
      f('valid_until', 'validUntil', 'date', '报价截止(含当日)', {
        readonly: true,
        filterable: true,
        sortable: true,
        calculated: true,
      }),
      f('quotation_status', 'quotationStatus', 'enum', '状态', {
        readonly: true,
        enumOptions: STATUS_OPTIONS,
        filterable: true,
        sortable: true,
        calculated: true,
      }),
      f('party_type', 'partyType', 'enum', spec.partyLabel, {
        readonly: true,
        enumOptions: PARTY_OPTIONS,
        filterable: true,
        sortable: true,
        calculated: true,
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
          discriminatorType,
          variants: spec.partyVariants.map((v) => ({
            value: v.value,
            resource: v.resource,
            labelField: 'name',
            label: v.label,
          })),
        },
      }),
      f('currency_code', 'currencyCode', 'string', '币种', {
        readonly: true,
        filterable: true,
        sortable: true,
        calculated: true,
      }),
      // 列表源含 q.currency_id，供有效报价候选筛选（对齐 Go itemSource）
      f('currency_id', 'currencyId', 'fk', '币种ID', {
        readonly: true,
        filterable: true,
        calculated: true,
        printOnly: true,
        ref: { resource: 'basCurrencies', relation: 'currency', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    printLoops: [{ name: 'tiers', resource: spec.tierResource }],
    audit: { enabled: true },
  }
}

export function quotationTierMeta(side: TradingSide): ResourceMeta {
  const spec = quotationSpec(side)
  return {
    name: spec.tierResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.tierTable,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('min_qty', 'minQty', 'decimal', '起订量(≥ 该量适用本档价)', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      f('price', 'price', 'decimal', '含税档价', {
        required: true,
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
      f('item_id', 'itemId', 'fk', '报价条目', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: {
          resource: spec.itemResource,
          relation: 'item',
          labelField: 'materialCode',
        },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },
  }
}
