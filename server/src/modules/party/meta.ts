import type { ResourceMeta } from '~/platform/meta/types.ts'

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
    name: 'salCustomers',
    permissionPrefix: 'sales.customer',
    permissionLabel: '客户',
    table: 'sal_customers',
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
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { required: true, placeholder: '如 C0001' },
        name: { required: true, placeholder: '客户全称' },
        shortName: { placeholder: '如 华为' },
      },
    },
    print: true,
    audit: { enabled: true },
    destroyMutation: 'destroySalCustomer',
  }
}

export function supplierResourceMeta(): ResourceMeta {
  return {
    name: 'purSuppliers',
    permissionPrefix: 'purchase.supplier',
    permissionLabel: '供应商',
    table: 'pur_supplier',
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
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { required: true, placeholder: '如 S0001' },
        name: { required: true, placeholder: '供应商全称' },
        shortName: { placeholder: '如 富士康' },
      },
    },
    print: true,
    audit: { enabled: true },
    destroyMutation: 'destroyPurSupplier',
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
    name: 'hrEmployees',
    permissionPrefix: 'hr.employee',
    permissionLabel: '员工',
    table: 'hr_employees',
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
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { required: false, placeholder: '留空自动编号' },
        name: { required: true },
      },
    },
    print: true,
    audit: { enabled: true, sensitiveFields: ['id_number'] },
    destroyMutation: 'destroyHrEmployee',
  }
}

export function allPartyResourceMetas(): ResourceMeta[] {
  return [customerResourceMeta(), supplierResourceMeta(), employeeResourceMeta()]
}

export const INSURANCE_WIRE = new Set(insuranceOptions.map((o) => o.value))
