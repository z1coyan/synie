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

const crudActions: ResourceMeta['actions'] = [
  { key: 'read', label: '查看', scope: 'both' },
  { key: 'create', label: '新增', scope: 'both' },
  { key: 'update', label: '编辑', scope: 'row' },
  { key: 'delete', label: '删除', scope: 'row', isDanger: true },
]

export const CURRENCY_RESOURCE_NAME = 'basCurrencies'
export const COMPANY_RESOURCE_NAME = 'basCompanies'
export const UNIT_RESOURCE_NAME = 'basUnits'
export const ACCOUNT_RESOURCE_NAME = 'basAccounts'

export function currencyResourceMeta(): ResourceMeta {
  return {
    name: CURRENCY_RESOURCE_NAME,
    permissionPrefix: 'base.currency',
    permissionLabel: '币种',
    table: 'bas_currency',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '货币名称', { required: true, filterable: true, sortable: true }),
      field('iso_code', 'isoCode', 'string', 'ISO 编码', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('symbol', 'symbol', 'string', '符号', { filterable: true, sortable: true }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
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
    ],
    actions: crudActions,
    form: {
      exclude: ['id', 'active', 'insertedAt', 'updatedAt'],
      fields: {
        name: { required: true, placeholder: '如 人民币' },
        isoCode: { required: true, edit: 'createOnly', placeholder: '三位大写字母,如 CNY' },
        symbol: { placeholder: '如 ¥' },
      },
    },
    audit: { enabled: true },
    destroyMutation: 'destroyBasCurrency',
  }
}

export function companyResourceMeta(): ResourceMeta {
  const companyResource = COMPANY_RESOURCE_NAME
  const companyRelation = 'parent'
  const nameField = 'name'
  const currencyResource = CURRENCY_RESOURCE_NAME
  const currencyRelation = 'baseCurrency'
  return {
    name: COMPANY_RESOURCE_NAME,
    permissionPrefix: 'base.company',
    permissionLabel: '公司',
    table: 'bas_company',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '公司编号', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '公司名称', { required: true, filterable: true, sortable: true }),
      field('short_name', 'shortName', 'string', '公司简称', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('parent_id', 'parentId', 'fk', '上级公司', {
        filterable: true,
        ref: { resource: companyResource, relation: companyRelation, labelField: nameField },
      }),
      field('base_currency_id', 'baseCurrencyId', 'fk', '本币', {
        required: true,
        filterable: true,
        ref: { resource: currencyResource, relation: currencyRelation, labelField: nameField },
      }),
    ],
    actions: crudActions,
    form: {
      exclude: ['id'],
      fields: {
        code: { required: true, edit: 'createOnly', placeholder: '两位英文字母,如 SH' },
        name: { required: true, placeholder: '如 上海总部' },
        shortName: { required: true, placeholder: '如 上海' },
        baseCurrencyId: { required: true, label: '本币' },
      },
    },
    audit: { enabled: true },
    destroyMutation: 'destroyBasCompany',
  }
}

const unitTypes = [
  { value: 'LENGTH', label: '长度' },
  { value: 'AREA', label: '面积' },
  { value: 'WEIGHT', label: '重量' },
  { value: 'QUANTITY', label: '数量' },
]

export function unitResourceMeta(): ResourceMeta {
  return {
    name: UNIT_RESOURCE_NAME,
    permissionPrefix: 'base.unit',
    permissionLabel: '计量单位',
    table: 'bas_unit',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('unit_type', 'unitType', 'enum', '单位类型', {
        required: true,
        enumOptions: unitTypes,
        filterable: true,
        sortable: true,
      }),
      field('is_base', 'isBase', 'boolean', '基准单位', { filterable: true, sortable: true }),
      field('name', 'name', 'string', '单位名称', { required: true, filterable: true, sortable: true }),
      field('symbol', 'symbol', 'string', '单位符号', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('ratio', 'ratio', 'decimal', '换算比例', {
        required: true,
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
    ],
    actions: crudActions,
    form: { exclude: ['id', 'insertedAt', 'updatedAt'] },
    print: true,
    audit: { enabled: true },
    destroyMutation: 'destroyBasUnit',
  }
}

const directionOptions = [
  { value: 'DEBIT', label: '借' },
  { value: 'CREDIT', label: '贷' },
]

const roleOptions = [
  { value: 'UNBILLED_RECEIVABLE', label: '未开票应收' },
  { value: 'RECEIVABLE', label: '应收账款' },
  { value: 'ADVANCE_RECEIVED', label: '预收款' },
  { value: 'UNBILLED_PAYABLE', label: '未开票应付' },
  { value: 'PAYABLE', label: '应付账款' },
  { value: 'OTHER_PAYABLE', label: '其他应付款' },
  { value: 'ADVANCE_PAID', label: '预付款' },
  { value: 'TRAVEL', label: '差旅费' },
  { value: 'OFFICE', label: '办公费' },
  { value: 'ENTERTAINMENT', label: '业务招待费' },
  { value: 'TRANSPORT', label: '交通费' },
  { value: 'OTHER_EXPENSE', label: '其他费用' },
]

export function accountResourceMeta(): ResourceMeta {
  const accountResource = ACCOUNT_RESOURCE_NAME
  const accountRelation = 'parent'
  const nameField = 'name'
  const companyResource = COMPANY_RESOURCE_NAME
  const companyRelation = 'company'
  const currencyResource = CURRENCY_RESOURCE_NAME
  const currencyRelation = 'currency'
  return {
    name: ACCOUNT_RESOURCE_NAME,
    permissionPrefix: 'base.account',
    permissionLabel: '会计科目',
    table: 'bas_account',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '科目编码', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '科目名称', { required: true, filterable: true, sortable: true }),
      field('direction', 'direction', 'enum', '余额方向', {
        required: true,
        enumOptions: directionOptions,
        filterable: true,
        sortable: true,
      }),
      field('is_group', 'isGroup', 'boolean', '汇总科目', { filterable: true, sortable: true }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
      field('role', 'role', 'enum', '科目角色', {
        enumOptions: roleOptions,
        filterable: true,
        sortable: true,
      }),
      field('has_children', 'hasChildren', 'boolean', '含下级科目', {
        calculated: true,
        printOnly: true,
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
      field('parent_id', 'parentId', 'fk', '上级科目', {
        filterable: true,
        ref: { resource: accountResource, relation: accountRelation, labelField: nameField },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: companyResource, relation: companyRelation, labelField: nameField },
      }),
      field('currency_id', 'currencyId', 'fk', '币种', {
        filterable: true,
        ref: { resource: currencyResource, relation: currencyRelation, labelField: nameField },
      }),
    ],
    actions: crudActions,
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { required: true, edit: 'createOnly' },
        companyId: { required: true, edit: 'createOnly' },
      },
    },
    printLoops: [{ name: 'children', resource: ACCOUNT_RESOURCE_NAME }],
    audit: { enabled: true },
    destroyMutation: 'destroyBasAccount',
  }
}

export function allBaseResourceMetas(): ResourceMeta[] {
  return [currencyResourceMeta(), companyResourceMeta(), unitResourceMeta(), accountResourceMeta()]
}
