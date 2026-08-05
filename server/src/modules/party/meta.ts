import type { ResourceMeta } from '~/platform/meta/types.ts'

export const CUSTOMER_RESOURCE_NAME = 'salCustomers'
export const SUPPLIER_RESOURCE_NAME = 'purSuppliers'
export const EMPLOYEE_RESOURCE_NAME = 'hrEmployees'
export const PARTY_ADDRESS_RESOURCE_NAME = 'basPartyAddresses'

function field(
  dbName: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name: dbName, apiName, dbColumn: dbName, type, label, ...opts }
}

const crud = [
  { key: 'read', label: '查看', scope: 'both' as const },
  { key: 'create', label: '新增', scope: 'both' as const },
  { key: 'update', label: '编辑', scope: 'row' as const },
  { key: 'delete', label: '删除', scope: 'row' as const, isDanger: true },
]

export function customerResourceMeta(): ResourceMeta {
  return {
    name: CUSTOMER_RESOURCE_NAME,
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'base.customer',
    permissionLabel: '客户',
    label: '客户',
    table: 'sal_customers',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '客户编号', { required: true, filterable: true, sortable: true }),
      field('name', 'name', 'string', '客户名称', { required: true, filterable: true, sortable: true }),
      field('short_name', 'shortName', 'string', '简称', { filterable: true, sortable: true }),
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
    actions: crud,
    form: {
      kind: 'basic',
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { placeholder: '如 C0001' },
        name: { placeholder: '客户全称' },
        shortName: { placeholder: '如 华为' },
      },
    },
    print: true,
    audit: { enabled: true },

  }
}

export function supplierResourceMeta(): ResourceMeta {
  return {
    name: SUPPLIER_RESOURCE_NAME,
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'base.supplier',
    permissionLabel: '供应商',
    label: '供应商',
    table: 'pur_supplier',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '供应商编号', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '供应商名称', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('short_name', 'shortName', 'string', '简称', { filterable: true, sortable: true }),
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
    actions: crud,
    form: {
      kind: 'basic',
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { placeholder: '如 S0001' },
        name: { placeholder: '供应商全称' },
        shortName: { placeholder: '如 富士康' },
      },
    },
    print: true,
    audit: { enabled: true },

  }
}

const insuranceOptions = [
  { value: 'SOCIAL_INJURY', label: '社保工伤' },
  { value: 'SOCIAL_UNEMPLOYMENT', label: '社保失业' },
  { value: 'SOCIAL_MEDICAL', label: '社保医疗' },
  { value: 'SOCIAL_PENSION', label: '社保养老' },
  { value: 'SOCIAL_MATERNITY', label: '社保生育' },
  { value: 'HOUSING_FUND', label: '公积金' },
  { value: 'COMMERCIAL_INJURY', label: '商保工伤' },
  { value: 'COMMERCIAL_MEDICAL', label: '商保医疗' },
]

export function employeeResourceMeta(): ResourceMeta {
  return {
    name: EMPLOYEE_RESOURCE_NAME,
    classification: { presentation: 'extension', interactive: true, note: '身份证影像 extraContent' },
    /** 证件照等影像宿主；owner_type 历史取单数 hr_employee，表无 company_id（全局宿主） */
    attachments: { ownerType: 'hr_employee' },
    permissionPrefix: 'hr.employee',
    numbering: true,
    permissionLabel: '员工',
    table: 'hr_employees',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '员工编号', { filterable: true, sortable: true }),
      field('name', 'name', 'string', '员工姓名', { required: true, filterable: true, sortable: true }),
      field('attendance_no', 'attendanceNo', 'string', '考勤设备编号', {
        filterable: true,
        sortable: true,
      }),
      field('id_number', 'idNumber', 'string', '身份证号', { filterable: true, sortable: true }),
      field('household_registration', 'householdRegistration', 'string', '户籍', {
        filterable: true,
        sortable: true,
      }),
      field('phone', 'phone', 'string', '手机号码', { filterable: true, sortable: true }),
      field('current_address', 'currentAddress', 'string', '现居住地', {
        filterable: true,
        sortable: true,
      }),
      field('daily_wage', 'dailyWage', 'decimal', '日薪', { filterable: true, sortable: true }),
      field('monthly_allowance', 'monthlyAllowance', 'decimal', '月补贴', {
        filterable: true,
        sortable: true,
      }),
      field('insurance_types', 'insuranceTypes', 'enumArray', '参保类型', {
        enumOptions: insuranceOptions,
        filterable: true,
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
    actions: crud,
    // 身份证影像：Presentation Extension
    form: {
      kind: 'extension',
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { required: false, placeholder: '留空自动编号' },
        name: { required: true },
      },
    },
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code', 'attendanceNo'],
      subtitleFields: ['code', 'attendanceNo'],
    },
    print: true,
    audit: { enabled: true, sensitiveFields: ['id_number'] },

  }
}

const partyAddressPartyTypes = [
  { value: 'CUSTOMER', label: '客户' },
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'COMPANY', label: '内部公司' },
]

const partyAddressPurposes = [
  { value: 'SHIPPING', label: '收发货' },
  { value: 'OFFICE', label: '通信办公' },
  { value: 'OTHER', label: '其他' },
]

/** 对手地址：从属客户/供应商/内部公司；无独立菜单，主体抽屉维护 */
export function partyAddressResourceMeta(): ResourceMeta {
  return {
    name: PARTY_ADDRESS_RESOURCE_NAME,
    classification: { presentation: 'basic', interactive: true, note: '无独立菜单；嵌客户/供应商/公司抽屉维护' },
    permissionPrefix: 'base.party_address',
    permissionLabel: '地址',
    label: '地址',
    table: 'bas_party_address',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('party_type', 'partyType', 'enum', '主体类型', {
        required: true,
        createOnly: true,
        enumOptions: partyAddressPartyTypes,
        filterable: true,
        sortable: true,
      }),
      field('party_id', 'partyId', 'uuid', '主体', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '地址名称', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('purpose', 'purpose', 'enum', '用途', {
        required: true,
        enumOptions: partyAddressPurposes,
        filterable: true,
        sortable: true,
      }),
      field('contact_name', 'contactName', 'string', '联系人', {
        filterable: true,
        sortable: true,
      }),
      field('contact_phone', 'contactPhone', 'string', '电话', {
        filterable: true,
        sortable: true,
      }),
      field('province', 'province', 'string', '省/直辖市', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('city', 'city', 'string', '市', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('district', 'district', 'string', '区/县', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('address', 'address', 'string', '街道门牌', {
        required: true,
        filterable: true,
      }),
      field('is_default', 'isDefault', 'boolean', '默认', {
        filterable: true,
        sortable: true,
      }),
      field('active', 'active', 'boolean', '启用', {
        filterable: true,
        sortable: true,
      }),
      field('remarks', 'remarks', 'string', '备注'),
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
    actions: crud,
    form: {
      kind: 'basic',
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        // required / createOnly 已在字段层声明，form 只放呈现提示
        name: { placeholder: '如 上海仓收货' },
        purpose: { defaultValue: 'SHIPPING' },
        contactName: { placeholder: '收货/联系人' },
        contactPhone: { placeholder: '手机或座机' },
        province: { placeholder: '省/直辖市' },
        city: { placeholder: '市' },
        district: { placeholder: '区/县' },
        address: { placeholder: '街道、门牌号等' },
        isDefault: { defaultValue: false },
        active: { defaultValue: true },
        remarks: {},
      },
    },
    audit: { enabled: true },
  }
}

export function allPartyResourceMetas(): ResourceMeta[] {
  return [
    customerResourceMeta(),
    supplierResourceMeta(),
    employeeResourceMeta(),
    partyAddressResourceMeta(),
  ]
}

export const INSURANCE_WIRE = new Set(insuranceOptions.map((o) => o.value))
