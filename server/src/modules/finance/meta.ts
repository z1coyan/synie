/**
 * 财务 Meta：增值税发票（09）+ 银行/票据/报销（12）。
 */
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { ACC_BANK_TRANSACTION } from './permissions.ts'

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
    classification: { presentation: 'extension', interactive: true, note: 'OCR Presentation Extension' },
    attachments: { companyScoped: true },
    permissionPrefix: 'acc.vat_invoice',
    numbering: true,
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
      },
      {
        key: 'void',
        label: '作废',
        scope: 'row',
        isDanger: true,
      },
      {
        key: 'reverse',
        label: '红冲',
        scope: 'row',
        isDanger: true,
      },
    ],
    // OCR / 动态联动 / 附件：Presentation Extension，不走 Basic Form
    form: { kind: 'extension' },
    // exclude 保留历史审计面：OCR 抬头块/红冲镜像/审核落章等不进审计 diff
    audit: {
      enabled: true,
      exclude: [
        'seller_name',
        'seller_tax_no',
        'seller_address_phone',
        'seller_bank_account',
        'buyer_name',
        'buyer_tax_no',
        'buyer_address_phone',
        'buyer_bank_account',
        'issuer',
        'reviewer',
        'payee',
        'red_invoice_no',
        'audited_at',
        'mirror_invoice_id',
        'created_by_id',
        'audited_by_id',
      ],
    },

  }
}


// ---- 工单 12：银行 / 票据 / 报销 Meta ----

const reconcileStatusOptions = [
  { value: 'UNRECONCILED', label: '未对账' },
  { value: 'PARTIAL', label: '部分对账' },
  { value: 'RECONCILED', label: '已对账' },
]

const importStatusOptions = [
  { value: 'PARSED', label: '已解析' },
  { value: 'FAILED', label: '解析失败' },
  { value: 'IMPORTED', label: '已导入' },
]

const datetimeFormatOptions = [
  { value: 'YMD_DASH_HMS', label: 'YYYY-MM-DD HH:mm:ss' },
  { value: 'YMD_DASH_HM', label: 'YYYY-MM-DD HH:mm' },
  { value: 'YMD_SLASH_HMS', label: 'YYYY/MM/DD HH:mm:ss' },
  { value: 'YMD_SLASH_HM', label: 'YYYY/MM/DD HH:mm' },
  { value: 'COMPACT_SPACE', label: 'YYYYMMDD HHmmss' },
  { value: 'COMPACT', label: 'YYYYMMDDHHmmss' },
  { value: 'ISO_T', label: 'YYYY-MM-DDTHH:mm:ss' },
  { value: 'CN_HMS', label: 'YYYY年MM月DD日 HH:mm:ss' },
  { value: 'MDY_SLASH_HMS', label: 'MM/DD/YYYY HH:mm:ss' },
  { value: 'DMY_SLASH_HMS', label: 'DD/MM/YYYY HH:mm:ss' },
]

const dateFormatOptions = [
  { value: 'YMD_DASH', label: 'YYYY-MM-DD' },
  { value: 'YMD_SLASH', label: 'YYYY/MM/DD' },
  { value: 'YMD_COMPACT', label: 'YYYYMMDD' },
  { value: 'YMD_DOT', label: 'YYYY.MM.DD' },
  { value: 'YMD_CN', label: 'YYYY年MM月DD日' },
  { value: 'MDY_SLASH', label: 'MM/DD/YYYY' },
  { value: 'DMY_SLASH', label: 'DD/MM/YYYY' },
  { value: 'DMY_DASH', label: 'DD-MM-YYYY' },
]

const timeFormatOptions = [
  { value: 'HMS', label: 'HH:mm:ss' },
  { value: 'HM', label: 'HH:mm' },
  { value: 'HMS_COMPACT', label: 'HHmmss' },
  { value: 'HMS_CN', label: 'HH时mm分ss秒' },
]

const expenseStatusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'VOIDED', label: '已作废' },
]

const expenseKindOptions = [
  { value: 'INVOICED', label: '挂票' },
  { value: 'MANUAL', label: '无票' },
]

const billKindOptions = [
  { value: 'BANK_ACCEPTANCE', label: '银行承兑汇票' },
  { value: 'COMMERCIAL_ACCEPTANCE', label: '商业承兑汇票' },
  { value: 'FINANCE_COMPANY_ACCEPTANCE', label: '财务公司承兑汇票' },
]

const billTxTypeOptions = [
  { value: 'RECEIVE', label: '接收' },
  { value: 'ENDORSE', label: '转让' },
  { value: 'SETTLE', label: '兑付' },
  { value: 'DISCOUNT', label: '贴现' },
  { value: 'REALLOCATE', label: '调拨' },
]

const crudActions = [
  { key: 'read', label: '查看', scope: 'both' as const },
  { key: 'create', label: '新增', scope: 'both' as const },
  { key: 'update', label: '编辑', scope: 'row' as const },
  { key: 'delete', label: '删除', scope: 'row' as const, isDanger: true },
]

export function bankAccountResourceMeta(): ResourceMeta {
  return {
    name: 'accBankAccounts',
    classification: { presentation: 'basic', interactive: true },
    attachments: { companyScoped: true },
    permissionPrefix: 'acc.bank_account',
    permissionLabel: '银行账户',
    table: 'acc_bank_account',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('alias', 'alias', 'string', '账户别名', { filterable: true, sortable: true }),
      field('bank_name', 'bankName', 'string', '所属银行', { filterable: true, sortable: true }),
      field('branch_name', 'branchName', 'string', '开户支行', { filterable: true, sortable: true }),
      field('holder_name', 'holderName', 'string', '户名', { filterable: true, sortable: true }),
      field('account_no', 'accountNo', 'string', '银行账号', { filterable: true, sortable: true }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('currency_id', 'currencyId', 'fk', '货币', {
        filterable: true, sortable: true,
        ref: { resource: 'basCurrencies', relation: 'currency', labelField: 'name' },
      }),
      field('account_id', 'accountId', 'fk', '绑定科目', {
        filterable: true, sortable: true,
        ref: { resource: 'basAccounts', relation: 'account', labelField: 'name' },
      }),
    ],
    actions: crudActions,
    form: {
      kind: 'basic',
      exclude: ['id', 'active', 'insertedAt', 'updatedAt'],
      fields: {
        companyId: { order: -1 },
        accountId: { order: 7, span: 6 },
      },
    },
    audit: { enabled: true },

  }
}

export function bankTransactionResourceMeta(): ResourceMeta {
  return {
    name: 'accBankTransactions',
    classification: { presentation: 'extension', interactive: true, note: '对账 reconcile 命令 + 导入' },
    attachments: { companyScoped: true },
    permissionPrefix: ACC_BANK_TRANSACTION.prefix,
    permissionLabel: '银行流水',
    table: 'acc_bank_transaction',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('occurred_at', 'occurredAt', 'datetime', '交易时间', { filterable: true, sortable: true }),
      field('income', 'income', 'decimal', '收入金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('expense', 'expense', 'decimal', '支出金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('balance', 'balance', 'decimal', '余额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('counterparty_name', 'counterpartyName', 'string', '对方户名', { filterable: true, sortable: true }),
      field('counterparty_account', 'counterpartyAccount', 'string', '对方账号', { filterable: true, sortable: true }),
      field('summary', 'summary', 'string', '摘要', { filterable: true, sortable: true }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('reconciled_amount', 'reconciledAmount', 'decimal', '已对账金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('unreconciled_amount', 'unreconciledAmount', 'decimal', '未对账金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('reconcile_status', 'reconcileStatus', 'enum', '对账状态', {
        enumOptions: reconcileStatusOptions, filterable: true, sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('bank_account_id', 'bankAccountId', 'fk', '银行账户', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankAccounts', relation: 'bankAccount', labelField: 'alias' },
      }),
    ],
    actions: [
      ...crudActions,
      { key: 'import', label: '导入', scope: 'both' },
      // v1：key=export 伪装（工单 11 删除）；v2：语义 key=reconcile、row target
      {
        key: 'export',
        permissionAction: 'reconcile',
        label: '对账',
        scope: 'both',
        commandTarget: 'row',
      },
    ],
    printHead: true,
    printLoops: [{ name: 'reconciliations', resource: 'accBankReconciliations' }],
    // exclude 保留历史审计面：对账派生列不进审计 diff
    audit: { enabled: true, exclude: ['reconciled_amount', 'unreconciled_amount', 'reconcile_status'] },

  }
}

export function bankImportTemplateResourceMeta(): ResourceMeta {
  return {
    name: 'accBankImportTemplates',
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'acc.bank_import_template',
    permissionLabel: '流水导入模板',
    table: 'acc_bank_import_template',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '模板名称', {
        required: true, filterable: true, sortable: true,
      }),
      field('start_row', 'startRow', 'integer', '起始行', {
        required: true, filterable: true, sortable: true,
      }),
      field('datetime_col', 'datetimeCol', 'string', '日期时间列', { filterable: true, sortable: true }),
      field('datetime_format', 'datetimeFormat', 'enum', '日期时间格式', {
        enumOptions: datetimeFormatOptions, filterable: true, sortable: true,
      }),
      field('date_col', 'dateCol', 'string', '日期列', { filterable: true, sortable: true }),
      field('date_format', 'dateFormat', 'enum', '日期格式', {
        enumOptions: dateFormatOptions, filterable: true, sortable: true,
      }),
      field('time_col', 'timeCol', 'string', '时间列', { filterable: true, sortable: true }),
      field('time_format', 'timeFormat', 'enum', '时间格式', {
        enumOptions: timeFormatOptions, filterable: true, sortable: true,
      }),
      field('income_col', 'incomeCol', 'string', '收入金额列', { filterable: true, sortable: true }),
      field('expense_col', 'expenseCol', 'string', '支出金额列', { filterable: true, sortable: true }),
      field('amount_col', 'amountCol', 'string', '金额列(带符号)', { filterable: true, sortable: true }),
      field('balance_col', 'balanceCol', 'string', '余额列', { filterable: true, sortable: true }),
      field('counterparty_name_col', 'counterpartyNameCol', 'string', '对方户名列', { filterable: true, sortable: true }),
      field('counterparty_account_col', 'counterpartyAccountCol', 'string', '对方账号列', { filterable: true, sortable: true }),
      field('summary_col', 'summaryCol', 'string', '摘要列', { filterable: true, sortable: true }),
      field('note_col', 'noteCol', 'string', '备注列', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('bank_account_id', 'bankAccountId', 'fk', '银行账户', {
        required: true, filterable: true, sortable: true,
        ref: { resource: 'accBankAccounts', relation: 'bankAccount', labelField: 'alias' },
      }),
    ],
    actions: crudActions,
    form: {
      kind: 'basic',
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        companyId: { order: -1 },
        name: { placeholder: '如 招行专业版对账单' },
        startRow: { initial: 2, placeholder: '数据首行,1 起数' },
        bankAccountId: { order: 2 },
        datetimeCol: { placeholder: '如 A;与日期/时间列二选一' },
        dateCol: { placeholder: '如 A;与日期时间列二选一' },
        timeCol: { placeholder: '可空,缺省按 00:00:00' },
        incomeCol: { placeholder: '如 C;与金额列互斥' },
        expenseCol: { placeholder: '如 D;与金额列互斥' },
        amountCol: { placeholder: '带符号:正=收入、负=支出' },
        balanceCol: { placeholder: '如 E' },
        counterpartyNameCol: { placeholder: '如 F' },
        counterpartyAccountCol: { placeholder: '如 G' },
        summaryCol: { placeholder: '如 H' },
        noteCol: { placeholder: '如 I' },
      },
    },
    audit: { enabled: true },

  }
}

export function bankImportResourceMeta(): ResourceMeta {
  return {
    name: 'accBankImports',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'acc.bank_transaction',
    permissionLabel: '银行流水',
    table: 'acc_bank_import',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        enumOptions: importStatusOptions, filterable: true, sortable: true,
      }),
      field('error', 'error', 'string', '解析失败原因', { filterable: true, sortable: true }),
      field('imported_at', 'importedAt', 'datetime', '导入时间', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('bank_account_id', 'bankAccountId', 'fk', '银行账户', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankAccounts', relation: 'bankAccount', labelField: 'alias' },
      }),
      field('template_id', 'templateId', 'fk', '导入模板', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankImportTemplates', relation: 'template', labelField: 'name' },
      }),
      field('file_id', 'fileId', 'fk', '导入文件', {
        filterable: true, sortable: true,
        ref: { resource: 'sysFiles', relation: 'file', labelField: 'filename' },
      }),
      field('created_by_id', 'createdById', 'fk', '发起人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('imported_by_id', 'importedById', 'fk', '导入人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'importedBy', labelField: 'name' },
      }),
      field('item_count', 'itemCount', 'integer', '行数', { readonly: true }),
      field('error_count', 'errorCount', 'integer', '错误行数', { readonly: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：聚合计数列不进审计 diff
    audit: { enabled: true, exclude: ['item_count', 'error_count'] },

  }
}

export function bankImportItemResourceMeta(): ResourceMeta {
  return {
    name: 'accBankImportItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'acc.bank_transaction',
    permissionLabel: '银行流水',
    table: 'acc_bank_import_item',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('row_no', 'rowNo', 'integer', '行号', { filterable: true, sortable: true }),
      field('occurred_at', 'occurredAt', 'datetime', '交易时间', { filterable: true, sortable: true }),
      field('income', 'income', 'decimal', '收入金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('expense', 'expense', 'decimal', '支出金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('balance', 'balance', 'decimal', '余额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('counterparty_name', 'counterpartyName', 'string', '对方户名', { filterable: true, sortable: true }),
      field('counterparty_account', 'counterpartyAccount', 'string', '对方账号', { filterable: true, sortable: true }),
      field('summary', 'summary', 'string', '摘要', { filterable: true, sortable: true }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('error', 'error', 'string', '行错误', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('import_id', 'importId', 'fk', '导入记录', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankImports', relation: 'import', labelField: 'error' },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('transaction_id', 'transactionId', 'fk', '生成的银行流水', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankTransactions', relation: 'transaction', labelField: 'summary' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function bankReconciliationResourceMeta(): ResourceMeta {
  return {
    name: 'accBankReconciliations',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'acc.bank_transaction',
    permissionLabel: '银行流水',
    table: 'acc_bank_reconciliation',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('amount', 'amount', 'decimal', '对账金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('bank_transaction_id', 'bankTransactionId', 'fk', '银行流水', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankTransactions', relation: 'bankTransaction', labelField: 'summary' },
      }),
      field('journal_id', 'journalId', 'fk', '凭证', {
        filterable: true, sortable: true,
        ref: { resource: 'accGlJournals', relation: 'journal', labelField: 'voucherNo' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function expenseReportResourceMeta(): ResourceMeta {
  return {
    name: 'accExpenseReports',
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: 'acc.expense_report',
    numbering: true,
    permissionLabel: '费用报销单',
    table: 'acc_expense_report',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '单据编号(留空自动取号)', { filterable: true, sortable: true }),
      field('expense_date', 'expenseDate', 'date', '报销日期', { filterable: true, sortable: true }),
      field('posting_date', 'postingDate', 'date', '过账日期', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true, enumOptions: expenseStatusOptions, filterable: true, sortable: true,
      }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', { readonly: true, filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('employee_id', 'employeeId', 'fk', '员工(报销对象)', {
        filterable: true, sortable: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
      field('payment_account_id', 'paymentAccountId', 'fk', '付款科目(贷方,银行存款/库存现金类;草稿必填)', {
        filterable: true, sortable: true,
        ref: { resource: 'basAccounts', relation: 'paymentAccount', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions: [
      ...crudActions,
      {
        key: 'audit', label: '审核', scope: 'row',
      },
      {
        key: 'void', label: '作废', scope: 'row', isDanger: true,
      },
    ],
    printHead: true,
    printLoops: [{ name: 'items', resource: 'accExpenseReportItems' }],
    // exclude 保留历史审计面：审核落章/经办人不进审计 diff
    audit: { enabled: true, exclude: ['audited_at', 'created_by_id', 'audited_by_id'] },

  }
}

export function expenseReportItemResourceMeta(): ResourceMeta {
  return {
    name: 'accExpenseReportItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'acc.expense_report',
    permissionLabel: '费用报销单',
    table: 'acc_expense_report_item',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('idx', 'idx', 'integer', '行号', { filterable: true, sortable: true }),
      field('kind', 'kind', 'enum', '行类型(挂票/无票)', {
        enumOptions: expenseKindOptions, filterable: true, sortable: true,
      }),
      field('summary', 'summary', 'string', '摘要(无票行必填)', { filterable: true, sortable: true }),
      field('amount', 'amount', 'decimal', '金额(无票行必填;挂票行金额取发票价税合计,不冗余存储)', {
        filterable: true, sortable: true, decimalScale: 2,
      }),
      field('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('report_id', 'reportId', 'fk', '报销单', {
        filterable: true, sortable: true,
        ref: { resource: 'accExpenseReports', relation: 'report', labelField: 'docNo' },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('invoice_id', 'invoiceId', 'fk', '挂票发票(挂票行必填)', {
        filterable: true, sortable: true,
        ref: { resource: 'accVatInvoices', relation: 'invoice', labelField: 'docNo' },
      }),
      field('expense_account_id', 'expenseAccountId', 'fk', '费用科目(无票行必填)', {
        filterable: true, sortable: true,
        ref: { resource: 'basAccounts', relation: 'expenseAccount', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function billResourceMeta(): ResourceMeta {
  return {
    name: 'accBills',
    classification: { presentation: 'extension', interactive: true, note: '票面影像附件' },
    /** 票面影像宿主：acc_bill 无 company_id（全局宿主） */
    attachments: { companyScoped: false },
    permissionPrefix: 'acc.bill',
    permissionLabel: '承兑票据',
    table: 'acc_bill',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('bill_no', 'billNo', 'string', '票据号码', { filterable: true, sortable: true }),
      field('bill_kind', 'billKind', 'enum', '票据种类', {
        enumOptions: billKindOptions, filterable: true, sortable: true,
      }),
      field('issue_date', 'issueDate', 'date', '出票日期', { filterable: true, sortable: true }),
      field('due_date', 'dueDate', 'date', '到期日', { filterable: true, sortable: true }),
      field('face_amount', 'faceAmount', 'decimal', '票据包金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('drawer_name', 'drawerName', 'string', '出票人名称', { filterable: true, sortable: true }),
      field('drawer_account', 'drawerAccount', 'string', '出票人账号', { filterable: true, sortable: true }),
      field('drawer_bank_name', 'drawerBankName', 'string', '出票人开户行', { filterable: true, sortable: true }),
      field('drawer_bank_no', 'drawerBankNo', 'string', '出票人开户行联行号', { filterable: true, sortable: true }),
      field('payee_name', 'payeeName', 'string', '收款人名称', { filterable: true, sortable: true }),
      field('payee_account', 'payeeAccount', 'string', '收款人账号', { filterable: true, sortable: true }),
      field('payee_bank_name', 'payeeBankName', 'string', '收款人开户行', { filterable: true, sortable: true }),
      field('payee_bank_no', 'payeeBankNo', 'string', '收款人开户行联行号', { filterable: true, sortable: true }),
      field('acceptor_name', 'acceptorName', 'string', '承兑人名称', { filterable: true, sortable: true }),
      field('acceptor_account', 'acceptorAccount', 'string', '承兑人账号', { filterable: true, sortable: true }),
      field('acceptor_bank_name', 'acceptorBankName', 'string', '承兑人开户行', { filterable: true, sortable: true }),
      field('acceptor_bank_no', 'acceptorBankNo', 'string', '承兑人开户行联行号', { filterable: true, sortable: true }),
      field('transferable', 'transferable', 'boolean', '能否转让', { filterable: true, sortable: true }),
      field('acceptance_date', 'acceptanceDate', 'date', '承兑日期', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    printHead: true,
    printLoops: [{ name: 'transactions', resource: 'accBillTransactions' }],
    // exclude 保留历史审计面：OCR 出票/收款/承兑人块不进审计 diff
    audit: {
      enabled: true,
      exclude: [
        'drawer_name',
        'drawer_account',
        'drawer_bank_name',
        'drawer_bank_no',
        'payee_name',
        'payee_account',
        'payee_bank_name',
        'payee_bank_no',
        'acceptor_name',
        'acceptor_account',
        'acceptor_bank_name',
        'acceptor_bank_no',
        'acceptance_date',
      ],
    },

  }
}

export function billTransactionResourceMeta(): ResourceMeta {
  return {
    name: 'accBillTransactions',
    classification: { presentation: 'extension', interactive: true },
    attachments: { companyScoped: true },
    permissionPrefix: 'acc.bill_transaction',
    numbering: true,
    permissionLabel: '承兑交易',
    table: 'acc_bill_transaction',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '单据编号', { filterable: true, sortable: true }),
      field('transaction_type', 'transactionType', 'enum', '交易类型', {
        enumOptions: billTxTypeOptions, filterable: true, sortable: true,
      }),
      field('occurred_on', 'occurredOn', 'date', '发生日期', { filterable: true, sortable: true }),
      field('sub_start', 'subStart', 'integer', '子票起', { filterable: true, sortable: true }),
      field('sub_end', 'subEnd', 'integer', '子票止', { filterable: true, sortable: true }),
      field('amount', 'amount', 'decimal', '交易金额(段金额)', { filterable: true, sortable: true, decimalScale: 2 }),
      field('party_type', 'partyType', 'enum', '对手类型', {
        enumOptions: partyOptions, filterable: true, sortable: true,
      }),
      field('party_id', 'partyId', 'fk', '交易对手', {
        filterable: true, sortable: true, printRawId: true,
        ref: {
          resource: null, relation: null, labelField: null,
          discriminator: 'partyType', discriminatorType: 'enum', variants: partyVariants,
        },
      }),
      field('discount_org', 'discountOrg', 'string', '贴现机构', { filterable: true, sortable: true }),
      field('discount_rate', 'discountRate', 'decimal', '贴现利率(年化%)', { filterable: true, sortable: true }),
      field('interest', 'interest', 'decimal', '贴现利息', { filterable: true, sortable: true, decimalScale: 2 }),
      field('net_amount', 'netAmount', 'decimal', '实收金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('posting_date', 'postingDate', 'date', '过账日期', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true, enumOptions: expenseStatusOptions, filterable: true, sortable: true,
      }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', { readonly: true, filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('bank_account_id', 'bankAccountId', 'fk', '本方银行账户(调拨为转出账户)', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankAccounts', relation: 'bankAccount', labelField: 'alias' },
      }),
      field('to_bank_account_id', 'toBankAccountId', 'fk', '调拨转入账户', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankAccounts', relation: 'toBankAccount', labelField: 'alias' },
      }),
      field('bill_id', 'billId', 'fk', '关联票据', {
        filterable: true, sortable: true,
        ref: { resource: 'accBills', relation: 'bill', labelField: 'billNo' },
      }),
      field('bill_account_id', 'billAccountId', 'fk', '票据科目', {
        filterable: true, sortable: true,
        ref: { resource: 'basAccounts', relation: 'billAccount', labelField: 'name' },
      }),
      field('settle_account_id', 'settleAccountId', 'fk', '结算科目', {
        filterable: true, sortable: true,
        ref: { resource: 'basAccounts', relation: 'settleAccount', labelField: 'name' },
      }),
      field('interest_account_id', 'interestAccountId', 'fk', '利息科目', {
        filterable: true, sortable: true,
        ref: { resource: 'basAccounts', relation: 'interestAccount', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions: [
      ...crudActions,
      {
        key: 'audit', label: '审核', scope: 'row',
      },
      {
        key: 'void', label: '作废', scope: 'row', isDanger: true,
      },
    ],
    // exclude 保留历史审计面：审核落章/经办人/备注不进审计 diff
    audit: { enabled: true, exclude: ['audited_at', 'remarks', 'created_by_id', 'audited_by_id'] },

  }
}

export function billHoldingResourceMeta(): ResourceMeta {
  return {
    name: 'accBillHoldings',
    classification: { presentation: 'none', interactive: false, note: '只读持有投影' },
    permissionPrefix: 'acc.bill_holding',
    permissionLabel: '持有承兑',
    table: 'acc_bill_holding',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('bill_no', 'billNo', 'string', '票据号码(冗余自票据主档)', { filterable: true, sortable: true }),
      field('sub_start', 'subStart', 'integer', '子票起', { filterable: true, sortable: true }),
      field('sub_end', 'subEnd', 'integer', '子票止', { filterable: true, sortable: true }),
      field('amount', 'amount', 'decimal', '持有金额', { filterable: true, sortable: true, decimalScale: 2 }),
      field('due_date', 'dueDate', 'date', '到期日(冗余自票据主档)', { filterable: true, sortable: true }),
      field('acquired_on', 'acquiredOn', 'date', '取得日期', { filterable: true, sortable: true }),
      {
        name: 'label', apiName: 'label', dbColumn: 'label', type: 'string',
        label: '展示标签', calculated: true, printOnly: true,
      },
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      field('company_id', 'companyId', 'fk', '公司', {
        filterable: true, sortable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('bank_account_id', 'bankAccountId', 'fk', '持有银行账户', {
        filterable: true, sortable: true,
        ref: { resource: 'accBankAccounts', relation: 'bankAccount', labelField: 'alias' },
      }),
      field('bill_id', 'billId', 'fk', '关联票据', {
        filterable: true, sortable: true,
        ref: { resource: 'accBills', relation: 'bill', labelField: 'billNo' },
      }),
      field('source_transaction_id', 'sourceTransactionId', 'fk', '来源交易(该段最近一次取得的交易)', {
        filterable: true, sortable: true,
        ref: { resource: 'accBillTransactions', relation: 'sourceTransaction', labelField: 'docNo' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

export function allFinanceResourceMetas(): ResourceMeta[] {
  return [
    vatInvoiceResourceMeta(),
    bankAccountResourceMeta(),
    bankTransactionResourceMeta(),
    bankImportTemplateResourceMeta(),
    bankImportResourceMeta(),
    bankImportItemResourceMeta(),
    bankReconciliationResourceMeta(),
    expenseReportResourceMeta(),
    expenseReportItemResourceMeta(),
    billResourceMeta(),
    billTransactionResourceMeta(),
    billHoldingResourceMeta(),
  ]
}
