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

/** 标准派生资源的动作词表：CRUD + 批量（批量端点由 platform/standard 派生） */
const standardActions: ResourceMeta['actions'] = [
  ...crudActions,
  { key: 'batch_update', label: '批量编辑', scope: 'bulk' },
  { key: 'batch_delete', label: '批量删除', scope: 'bulk', isDanger: true },
]

export const CURRENCY_RESOURCE_NAME = 'basCurrencies'
export const COMPANY_RESOURCE_NAME = 'basCompanies'
export const UNIT_RESOURCE_NAME = 'basUnits'
export const ACCOUNT_RESOURCE_NAME = 'basAccounts'

export function currencyResourceMeta(): ResourceMeta {
  return {
    name: CURRENCY_RESOURCE_NAME,
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'base.currency',
    permissionLabel: '币种',
    /** 界面显示「货币」，与历史 drawer 标签一致；权限组仍为「币种」 */
    label: '货币',
    table: 'bas_currency',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '货币名称', {
        required: true,
        maxLength: 64,
        filterable: true,
        sortable: true,
      }),
      field('iso_code', 'isoCode', 'string', 'ISO 编码', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('symbol', 'symbol', 'string', '符号', {
        nullable: true,
        maxLength: 8,
        filterable: true,
        sortable: true,
      }),
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
    actions: standardActions,
    form: {
      kind: 'basic',
      exclude: ['id', 'active', 'insertedAt', 'updatedAt'],
      fields: {
        name: { placeholder: '如 人民币' },
        isoCode: { placeholder: '三位大写字母,如 CNY' },
        symbol: { placeholder: '如 ¥' },
      },
    },
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'isoCode'],
      subtitleFields: ['isoCode'],
    },
    audit: { enabled: true },

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
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'base.company',
    permissionLabel: '公司',
    label: '公司',
    table: 'bas_company',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '公司编号', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '公司名称', {
        required: true,
        maxLength: 128,
        filterable: true,
        sortable: true,
      }),
      field('short_name', 'shortName', 'string', '公司简称', {
        required: true,
        maxLength: 32,
        filterable: true,
        sortable: true,
      }),
      field('parent_id', 'parentId', 'fk', '上级公司', {
        nullable: true,
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
      kind: 'basic',
      exclude: ['id'],
      fields: {
        code: { placeholder: '两位英文字母,如 SH' },
        name: { placeholder: '如 上海总部' },
        shortName: { placeholder: '如 上海' },
        // 本币：记账主体的记账货币；仅启用币种可选（拦新不拦旧）
        baseCurrencyId: {
          filterState: { active: { kind: 'bool', eq: true } },
        },
        parentId: {},
      },
    },
    audit: { enabled: true },

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
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'base.unit',
    permissionLabel: '计量单位',
    /** 界面显示「单位」，与历史 drawer 标签一致；权限组仍为「计量单位」 */
    label: '单位',
    table: 'bas_unit',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('unit_type', 'unitType', 'enum', '单位类型', {
        required: true,
        enumOptions: unitTypes,
        filterable: true,
        sortable: true,
      }),
      field('is_base', 'isBase', 'boolean', '基准单位', { filterable: true, sortable: true }),
      field('name', 'name', 'string', '单位名称', {
        required: true,
        maxLength: 32,
        filterable: true,
        sortable: true,
      }),
      field('symbol', 'symbol', 'string', '单位符号', {
        required: true,
        maxLength: 16,
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
    actions: standardActions,
    form: {
      kind: 'basic',
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        unitType: {},
        isBase: {},
        name: { placeholder: '如 千克', span: 6 },
        symbol: { placeholder: '如 kg', span: 6 },
        // 基准单位比例恒为 1(后端校验)；普通单位填换算到基准单位的比例
        ratio: { initial: 1, placeholder: '换算到基准单位的比例' },
      },
    },
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'symbol'],
      subtitleFields: ['symbol'],
    },
    print: true,
    audit: { enabled: true },

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
    classification: { presentation: 'extension', interactive: true, note: '汇总科目 effects + role 动态可见 + 公司上下文 parent 筛选' },
    permissionPrefix: 'base.account',
    permissionLabel: '会计科目',
    table: 'bas_account',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '科目编码', {
        required: true,
        createOnly: true,
        maxLength: 32,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '科目名称', {
        required: true,
        maxLength: 128,
        filterable: true,
        sortable: true,
      }),
      field('direction', 'direction', 'enum', '余额方向', {
        required: true,
        enumOptions: directionOptions,
        filterable: true,
        sortable: true,
      }),
      field('is_group', 'isGroup', 'boolean', '汇总科目', { filterable: true, sortable: true }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
      field('role', 'role', 'enum', '科目角色', {
        nullable: true,
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
        nullable: true,
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
        nullable: true,
        filterable: true,
        ref: { resource: currencyResource, relation: currencyRelation, labelField: nameField },
      }),
    ],
    actions: crudActions,
    form: {
      kind: 'extension',
      exclude: ['id', 'insertedAt', 'updatedAt', 'hasChildren', 'active'],
      fields: {
        code: { required: true, edit: 'createOnly', cols: 6, placeholder: '如 1001' },
        companyId: { required: true, edit: 'createOnly' },
        currencyId: {
          cols: 6,
          filterState: { active: { kind: 'bool', eq: true } },
        },
        parentId: { cols: 6 },
        name: { required: true, cols: 6, placeholder: '如 库存现金' },
        direction: { required: true, cols: 6 },
        isGroup: { cols: 6, defaultValue: false },
        role: { cols: 6 },
      },
    },
    printLoops: [{ name: 'children', resource: ACCOUNT_RESOURCE_NAME }],
    audit: { enabled: true },

  }
}

export function allBaseResourceMetas(): ResourceMeta[] {
  return [currencyResourceMeta(), companyResourceMeta(), unitResourceMeta(), accountResourceMeta()]
}
