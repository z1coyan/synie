/**
 * 财务单据 Meta：增值税发票（工单 09；报销/票据属工单 12）。
 */
import type { ResourceMeta } from '~/platform/meta/types.ts'

function field(
  dbName: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return {
    name: dbName,
    apiName,
    dbColumn: dbName,
    type,
    label,
    ...opts,
  }
}

const partyOptions = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
]

const directionOptions = [
  { value: 'INBOUND', label: '开入' },
  { value: 'OUTBOUND', label: '开出' },
]

const invoiceKindOptions = [
  { value: 'SPECIAL', label: '增值税专用发票' },
  { value: 'NORMAL', label: '增值税普通发票' },
  { value: 'ELECTRONIC_SPECIAL', label: '电子专用发票' },
  { value: 'ELECTRONIC_NORMAL', label: '电子普通发票' },
  { value: 'DIGITAL_SPECIAL', label: '数电专票' },
  { value: 'DIGITAL_NORMAL', label: '数电普票' },
]

const statusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'VOIDED', label: '已作废' },
  { value: 'REVERSED', label: '已红冲' },
]

const partyVariants = [
  { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
  { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
  { value: 'EMPLOYEE', resource: 'hrEmployees', labelField: 'name', label: '员工' },
  { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
]

export const VAT_INVOICE_RESOURCE_NAME = 'accVatInvoices'

export function vatInvoiceResourceMeta(): ResourceMeta {
  return {
    name: VAT_INVOICE_RESOURCE_NAME,
    permissionPrefix: 'acc.vat_invoice',
    permissionLabel: '增值税发票',
    table: 'acc_vat_invoice',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '内部单据编号', { filterable: true, sortable: true }),
      field('direction', 'direction', 'enum', '开票方向', {
        required: true,
        enumOptions: directionOptions,
        filterable: true,
        sortable: true,
      }),
      field('invoice_date', 'invoiceDate', 'date', '开票日期', { filterable: true, sortable: true }),
      field('posting_date', 'postingDate', 'date', '过账日期', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('party_type', 'partyType', 'enum', '对手类型', {
        required: true,
        enumOptions: partyOptions,
        filterable: true,
        sortable: true,
      }),
      field('party_id', 'partyId', 'fk', '对手', {
        required: true,
        filterable: true,
        sortable: true,
        printRawId: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: 'partyType',
          discriminatorType: 'enum',
          variants: partyVariants,
        },
      }),
      field('invoice_kind', 'invoiceKind', 'enum', '发票种类', {
        required: true,
        enumOptions: invoiceKindOptions,
        filterable: true,
        sortable: true,
      }),
      field('invoice_code', 'invoiceCode', 'string', '发票代码(数电票为空串)', {
        filterable: true,
        sortable: true,
      }),
      field('invoice_no', 'invoiceNo', 'string', '发票号码', { filterable: true, sortable: true }),
      field('seller_name', 'sellerName', 'string', '销方名称', { filterable: true, sortable: true }),
      field('seller_tax_no', 'sellerTaxNo', 'string', '销方纳税人识别号', {
        filterable: true,
        sortable: true,
      }),
      field('seller_address_phone', 'sellerAddressPhone', 'string', '销方地址、电话'),
      field('seller_bank_account', 'sellerBankAccount', 'string', '销方开户行及账号'),
      field('buyer_name', 'buyerName', 'string', '购方名称', { filterable: true, sortable: true }),
      field('buyer_tax_no', 'buyerTaxNo', 'string', '购方纳税人识别号', {
        filterable: true,
        sortable: true,
      }),
      field('buyer_address_phone', 'buyerAddressPhone', 'string', '购方地址、电话'),
      field('buyer_bank_account', 'buyerBankAccount', 'string', '购方开户行及账号'),
      field('items', 'items', 'json', '发票明细', { readonly: true }),
      field('net_total', 'netTotal', 'decimal', '不含税金额', {
        filterable: true,
        sortable: true,
        decimalScale: 2,
      }),
      field('tax_total', 'taxTotal', 'decimal', '税额', {
        filterable: true,
        sortable: true,
        decimalScale: 2,
      }),
      field('gross_total', 'grossTotal', 'decimal', '价税合计', {
        filterable: true,
        sortable: true,
        decimalScale: 2,
      }),
      field('issuer', 'issuer', 'string', '开票人'),
      field('reviewer', 'reviewer', 'string', '复核人'),
      field('payee', 'payee', 'string', '收款人'),
      field('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      field('red_invoice_no', 'redInvoiceNo', 'string', '红冲对应原发票号码'),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: statusOptions,
        filterable: true,
        sortable: true,
      }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('party_account_id', 'partyAccountId', 'fk', '往来科目', {
        filterable: true,
        sortable: true,
        ref: { resource: 'basAccounts', relation: 'partyAccount', labelField: 'name' },
      }),
      field('amount_account_id', 'amountAccountId', 'fk', '金额科目', {
        filterable: true,
        sortable: true,
        ref: { resource: 'basAccounts', relation: 'amountAccount', labelField: 'name' },
      }),
      field('tax_account_id', 'taxAccountId', 'fk', '税额科目', {
        filterable: true,
        sortable: true,
        ref: { resource: 'basAccounts', relation: 'taxAccount', labelField: 'name' },
      }),
      field('mirror_invoice_id', 'mirrorInvoiceId', 'fk', '对向发票', {
        filterable: true,
        sortable: true,
        ref: { resource: 'accVatInvoices', relation: 'mirrorInvoice', labelField: 'docNo' },
      }),
      field(
        'sal_reconciliation_id',
        'salReconciliationId',
        'fk',
        '关联销售对账单(仅开出发票、草稿可改;审核一对一结单)',
        {
          filterable: true,
          sortable: true,
          ref: {
            resource: 'salReconciliations',
            relation: 'salReconciliation',
            labelField: 'reconciliationNo',
          },
        },
      ),
      field(
        'pur_reconciliation_id',
        'purReconciliationId',
        'fk',
        '关联采购对账单(仅开入发票、对手非员工时草稿必填;审核一对一结单)',
        {
          filterable: true,
          sortable: true,
          ref: {
            resource: 'purReconciliations',
            relation: 'purReconciliation',
            labelField: 'reconciliationNo',
          },
        },
      ),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      {
        key: 'audit',
        label: '审核',
        scope: 'row',
        mutation: 'auditAccVatInvoice',
        http: { method: 'POST', path: '/finance/vat-invoices/{id}/audit' },
      },
      {
        key: 'void',
        label: '作废',
        scope: 'row',
        mutation: 'voidAccVatInvoice',
        isDanger: true,
        http: { method: 'POST', path: '/finance/vat-invoices/{id}/void' },
      },
      {
        key: 'reverse',
        label: '红冲',
        scope: 'row',
        mutation: 'reverseAccVatInvoice',
        isDanger: true,
        http: { method: 'POST', path: '/finance/vat-invoices/{id}/reverse' },
      },
    ],
    audit: { enabled: true },
    destroyMutation: 'destroyAccVatInvoice',
  }
}

export function allFinanceResourceMetas(): ResourceMeta[] {
  return [vatInvoiceResourceMeta()]
}
