// bun app/components/synie-record-drawer/record-drawer-checks.ts 可直接运行的纯函数自检
import {
  collectValues,
  initialValues,
  isFieldDisabled,
  missingRequired,
  resolveFields,
  visibleFields,
} from './fields'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'

const col = (name: string, type: GridColumnMeta['type'], enumOptions: GridColumnMeta['enumOptions'] = null): GridColumnMeta => ({
  name,
  type,
  label: `L:${name}`,
  sortable: true,
  filterable: true,
  enumOptions,
})

const cols: GridColumnMeta[] = [
  col('id', 'string'),
  col('code', 'string'),
  col('name', 'string'),
  col('seq', 'integer'),
  col('price', 'decimal'),
  col('enabled', 'boolean'),
  col('dueOn', 'date'),
  col('happenedAt', 'datetime'),
  col('counterpartyType', 'enum', [
    { value: 'customer', label: '客户' },
    { value: 'supplier', label: '供应商' },
  ]),
  col('customerId', 'string'),
  col('supplierId', 'string'),
  col('insertedAt', 'datetime'),
]

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

// —— resolveFields:系统字段 create/edit 剔除、view 保留;exclude 叠加;overrides 生效 ——
const createFields = resolveFields(cols, 'create', ['supplierId'], {
  code: { edit: 'createOnly', required: true },
  name: { cols: 6, label: '名称' },
})
eq(
  createFields.map((f) => f.name),
  ['code', 'name', 'seq', 'price', 'enabled', 'dueOn', 'happenedAt', 'counterpartyType', 'customerId'],
  'create 剔除 id/insertedAt 系统字段与 exclude'
)
eq(resolveFields(cols, 'view', [], {}).some((f) => f.name === 'insertedAt'), true, 'view 保留系统字段')
eq(createFields[0].edit, 'createOnly', 'override edit 生效')
eq(createFields[0].required, true, 'override required 生效')
eq(createFields.find((f) => f.name === 'name')!.cols, 6, 'override cols 生效')
eq(createFields.find((f) => f.name === 'name')!.label, '名称', 'override label 生效')
eq(createFields.find((f) => f.name === 'seq')!.cols, 12, '默认 cols=12')
eq(resolveFields(cols, 'create', [], { seq: { cols: 99 } }).find((f) => f.name === 'seq')!.cols, 12, 'cols 上限 12')
eq(resolveFields(cols, 'create', [], { seq: { cols: 0 } }).find((f) => f.name === 'seq')!.cols, 1, 'cols 下界 1')
eq(resolveFields(cols, 'create', [], { seq: { cols: 6.4 } }).find((f) => f.name === 'seq')!.cols, 6, 'cols 非整数取整')

// —— isFieldDisabled 三值 × create/edit ——
const fOf = (edit?: 'editable' | 'createOnly' | 'readOnly') =>
  resolveFields([col('x', 'string')], 'create', [], { x: { edit } })[0]
eq(isFieldDisabled(fOf('editable'), 'create'), false, 'editable create 可输入')
eq(isFieldDisabled(fOf('editable'), 'edit'), false, 'editable edit 可输入')
eq(isFieldDisabled(fOf('createOnly'), 'create'), false, 'createOnly create 可输入')
eq(isFieldDisabled(fOf('createOnly'), 'edit'), true, 'createOnly edit 禁用')
eq(isFieldDisabled(fOf('readOnly'), 'create'), true, 'readOnly create 禁用')
eq(isFieldDisabled(fOf('readOnly'), 'edit'), true, 'readOnly edit 禁用')

// —— visibleFields:条件字段按当前 values 过滤 ——
const condFields = resolveFields(cols, 'create', [], {
  customerId: { visible: (v) => v.counterpartyType === 'customer' },
  supplierId: { visible: (v) => v.counterpartyType === 'supplier' },
})
eq(
  visibleFields(condFields, { counterpartyType: 'customer' }).some((f) => f.name === 'customerId'),
  true,
  '客户态显示 customerId'
)
eq(
  visibleFields(condFields, { counterpartyType: 'customer' }).some((f) => f.name === 'supplierId'),
  false,
  '客户态隐藏 supplierId'
)
eq(visibleFields(condFields, {}).some((f) => f.name === 'customerId'), false, '未选类型两者都不显示')
eq(visibleFields(condFields, {}).some((f) => f.name === 'name'), true, '无谓词字段恒显示')

// —— initialValues:create 按类型给空值 + defaultValue;edit 从行数据归一化 ——
const ivCreate = initialValues(resolveFields(cols, 'create', [], { enabled: { defaultValue: true } }), null)
eq(ivCreate.code, '', 'create string 初值空串')
eq(ivCreate.enabled, true, 'create defaultValue 生效')
eq(ivCreate.seq, null, 'create number 初值 null')
eq(ivCreate.dueOn, null, 'create date 初值 null')
eq(ivCreate.counterpartyType, null, 'create enum 初值 null')

const row: Row = {
  id: '1',
  code: 'a',
  name: null,
  seq: 3,
  price: '12.50',
  enabled: true,
  dueOn: '2026-01-05',
  happenedAt: '2026-01-05T08:30:00Z',
  counterpartyType: 'customer',
  customerId: 'c1',
  supplierId: null,
} as unknown as Row
const ivEdit = initialValues(resolveFields(cols, 'edit', [], {}), row)
eq(ivEdit.price, 12.5, 'edit decimal 字符串归一为 number')
eq(ivEdit.happenedAt, '2026-01-05', 'edit datetime ISO 截取日期位')
eq(ivEdit.dueOn, '2026-01-05', 'edit date 原样')
eq(ivEdit.name, '', 'edit string null 归一空串')
eq(ivEdit.enabled, true, 'edit boolean 原样')

// —— collectValues:createOnly 编辑态剔除;隐藏字段剔除;undefined 归 null ——
const submitFields = resolveFields(cols, 'edit', [], {
  code: { edit: 'createOnly' },
  customerId: { visible: (v) => v.counterpartyType === 'customer' },
  supplierId: { visible: (v) => v.counterpartyType === 'supplier' },
})
const submitted = collectValues(
  submitFields,
  { code: 'a', name: 'n', counterpartyType: 'supplier', customerId: 'c1', supplierId: 's1', seq: undefined },
  'edit'
)
eq('code' in submitted, false, 'createOnly 编辑态不进 payload')
eq('customerId' in submitted, false, '隐藏字段不进 payload(草稿仍在)')
eq(submitted.supplierId, 's1', '可见字段进 payload')
eq(submitted.name, 'n', '普通字段进 payload')
eq(submitted.seq, null, 'undefined 归 null')
eq('id' in submitted, false, '系统字段不进 payload')

const createSubmitted = collectValues(
  resolveFields(cols, 'create', [], { code: { edit: 'createOnly' }, price: { edit: 'readOnly' } }),
  { code: 'a', price: 1 },
  'create'
)
eq(createSubmitted.code, 'a', 'createOnly 创建态进 payload')
eq('price' in createSubmitted, false, 'readOnly 创建态不进 payload')

// —— missingRequired:只查当前可见且可编辑;false/0 不算空 ——
const reqFields = resolveFields(cols, 'create', [], {
  code: { required: true },
  seq: { required: true },
  enabled: { required: true },
  price: { required: true, edit: 'readOnly' },
  customerId: { required: true, visible: (v) => v.counterpartyType === 'customer' },
})
eq(
  missingRequired(reqFields, { code: '', seq: 0, enabled: false, counterpartyType: 'supplier' }, 'create'),
  ['L:code'],
  '空串缺失;0/false 不算空;readOnly 与隐藏的 required 不拦'
)
eq(
  missingRequired(reqFields, { code: '   ', seq: 0, enabled: false, counterpartyType: 'supplier' }, 'create'),
  ['L:code'],
  '纯空格视为空'
)
eq(
  missingRequired(reqFields, { code: 'a', seq: 1, enabled: false, counterpartyType: 'customer' }, 'create'),
  ['L:customerId'],
  '条件字段显形后必填生效'
)

console.log('record-drawer-checks ok')
