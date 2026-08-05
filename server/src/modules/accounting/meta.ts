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

const statusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'CANCELLED', label: '已取消' },
]

export const JOURNAL_RESOURCE_NAME = 'accGlJournals'
export const JOURNAL_LINE_RESOURCE_NAME = 'accGlJournalLines'
export const GL_ENTRY_RESOURCE_NAME = 'accGlEntries'

export function journalResourceMeta(): ResourceMeta {
  const company = 'basCompanies'
  const user = 'sysUsers'
  const name = 'name'
  return {
    name: JOURNAL_RESOURCE_NAME,
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: 'acc.gl_journal',
    numbering: true,
    permissionLabel: '会计凭证',
    table: 'acc_gl_journal',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('voucher_no', 'voucherNo', 'string', '凭证编号', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('date', 'date', 'date', '单据日期', { required: true, filterable: true, sortable: true }),
      field('posting_date', 'postingDate', 'date', '过账日期', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '凭证备注', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: statusOptions,
        filterable: true,
        sortable: true,
      }),
      field('submitted_at', 'submittedAt', 'datetime', '提交时间', {
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
        ref: { resource: company, relation: 'company', labelField: name },
      }),
      field('created_by_id', 'createdById', 'fk', '编写人', {
        readonly: true,
        filterable: true,
        ref: { resource: user, relation: 'createdBy', labelField: name },
      }),
      field('submitted_by_id', 'submittedById', 'fk', '提交人', {
        readonly: true,
        filterable: true,
        ref: { resource: user, relation: 'submittedBy', labelField: name },
      }),
      field('debit_total', 'debitTotal', 'decimal', '借方总金额', {
        readonly: true,
        calculated: true,
      }),
      field('credit_total', 'creditTotal', 'decimal', '贷方总金额', {
        readonly: true,
        calculated: true,
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'audit', label: '审核', scope: 'row' },
      { key: 'cancel', label: '取消', scope: 'row', isDanger: true },
    ],
    printHead: true,
    printLoops: [{ name: 'lines', resource: JOURNAL_LINE_RESOURCE_NAME }],
    audit: { enabled: true },

  }
}

export function journalLineResourceMeta(): ResourceMeta {
  const discriminator = 'partyType'
  const journal = JOURNAL_RESOURCE_NAME
  const company = 'basCompanies'
  const account = 'basAccounts'
  const currency = 'basCurrencies'
  const voucherNo = 'voucherNo'
  const name = 'name'
  return {
    name: JOURNAL_LINE_RESOURCE_NAME,
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'acc.gl_journal',
    permissionLabel: '会计凭证',
    table: 'acc_gl_journal_line',
    authz: { kind: 'via', parent: 'accGlJournals', fk: 'journal_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      field('debit', 'debit', 'decimal', '借方金额', { required: true, filterable: true, sortable: true }),
      field('credit', 'credit', 'decimal', '贷方金额', { required: true, filterable: true, sortable: true }),
      field('party_type', 'partyType', 'enum', '对手类型', {
        enumOptions: partyOptions,
        filterable: true,
        sortable: true,
      }),
      field('party_id', 'partyId', 'fk', '对手', {
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
            { value: 'EMPLOYEE', resource: 'hrEmployees', labelField: 'name', label: '员工' },
            { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
          ],
        },
      }),
      field('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
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
      field('journal_id', 'journalId', 'fk', '凭证', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: journal, relation: 'journal', labelField: voucherNo },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: company, relation: 'company', labelField: name },
      }),
      field('account_id', 'accountId', 'fk', '科目', {
        required: true,
        filterable: true,
        ref: { resource: account, relation: 'account', labelField: name },
      }),
      field('currency_id', 'currencyId', 'fk', '币种', {
        readonly: true,
        filterable: true,
        ref: { resource: currency, relation: 'currency', labelField: name },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function glEntryResourceMeta(): ResourceMeta {
  const partyDiscriminator = 'partyType'
  const voucherDiscriminator = 'voucherType'
  const company = 'basCompanies'
  const account = 'basAccounts'
  const currency = 'basCurrencies'
  const name = 'name'
  return {
    name: GL_ENTRY_RESOURCE_NAME,
    classification: { presentation: 'none', interactive: false, note: '只读总账分录' },
    permissionPrefix: 'acc.gl_entry',
    permissionLabel: '总账分录',
    table: 'acc_gl_entry',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('seq', 'seq', 'integer', '序号', { readonly: true, filterable: true, sortable: true }),
      field('posting_date', 'postingDate', 'date', '过账日期', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('debit', 'debit', 'decimal', '借方金额', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('credit', 'credit', 'decimal', '贷方金额', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('party_type', 'partyType', 'enum', '对手类型', {
        readonly: true,
        enumOptions: partyOptions,
        filterable: true,
        sortable: true,
      }),
      field('party_id', 'partyId', 'fk', '对手', {
        readonly: true,
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: partyDiscriminator,
          discriminatorType: 'enum',
          variants: [
            { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
            { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
            { value: 'EMPLOYEE', resource: 'hrEmployees', labelField: 'name', label: '员工' },
            { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
          ],
        },
      }),
      field('voucher_type', 'voucherType', 'string', '来源单据类型', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('voucher_id', 'voucherId', 'fk', '来源单据', {
        readonly: true,
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: voucherDiscriminator,
          discriminatorType: 'string',
          variants: [
            { value: 'acc.bill_transaction', resource: 'accBillTransactions', labelField: 'docNo', label: '承兑交易' },
            { value: 'acc.expense_report', resource: 'accExpenseReports', labelField: 'docNo', label: '报销单' },
            { value: 'acc.gl_journal', resource: 'accGlJournals', labelField: 'voucherNo', label: '凭证' },
            { value: 'acc.vat_invoice', resource: 'accVatInvoices', labelField: 'docNo', label: '增值税发票' },
            {
              value: 'purchase.outsourced_receipt',
              resource: 'purOutsourcedReceipts',
              labelField: 'receiptNo',
              label: '委外入库单',
            },
            { value: 'purchase.receipt', resource: 'purReceipts', labelField: 'receiptNo', label: '采购入库单' },
            {
              value: 'purchase.reconciliation',
              resource: 'purReconciliations',
              labelField: 'reconciliationNo',
              label: '采购对账单',
            },
            { value: 'sales.delivery', resource: 'salDeliveries', labelField: 'deliveryNo', label: '销售发货单' },
            {
              value: 'sales.reconciliation',
              resource: 'salReconciliations',
              labelField: 'reconciliationNo',
              label: '销售对账单',
            },
          ],
        },
      }),
      field('voucher_no', 'voucherNo', 'string', '来源单据编号', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('is_cancelled', 'isCancelled', 'boolean', '已作废', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('is_reversed', 'isReversed', 'boolean', '已被红冲(原凭证状态)', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('is_reversal', 'isReversal', 'boolean', '红字冲销行', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('remarks', 'remarks', 'string', '摘要', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: company, relation: 'company', labelField: name },
      }),
      field('account_id', 'accountId', 'fk', '科目', {
        readonly: true,
        filterable: true,
        ref: { resource: account, relation: 'account', labelField: name },
      }),
      field('currency_id', 'currencyId', 'fk', '币种', {
        readonly: true,
        filterable: true,
        ref: { resource: currency, relation: 'currency', labelField: name },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: false },
  }
}

export function allAccountingResourceMetas(): ResourceMeta[] {
  return [journalResourceMeta(), journalLineResourceMeta(), glEntryResourceMeta()]
}
