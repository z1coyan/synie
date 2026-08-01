// bun app/components/synie-remote-select/remote-select-checks.ts 可直接运行的纯函数自检
import { optionLabel, resolveFkTarget, resolveSource } from './remote-query'
import type { Row } from '../synie-data-grid/types'

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

const ref = { resource: 'basCompanies', relation: 'parent', labelField: 'name' }

// resolveSource：ref 提供默认，config 覆盖；都无 resource 为 null。
eq(resolveSource({}, ref), {
  resource: 'basCompanies',
  client: { id: 'rest:basCompanies' },
  labelField: 'name',
  sortField: 'name',
  searchFields: ['name'],
  fields: [],
  pageSize: 20,
  itemSubtitleFields: [],
}, 'ref 默认值')

// 资源级默认：员工三字段搜索 + 编号副行；页面 config 仍可覆盖。
const employee = resolveSource({ resource: 'hrEmployees' })!
eq(employee.searchFields, ['name', 'code', 'attendanceNo'], '员工资源级默认搜索字段')
eq(employee.itemSubtitleFields, ['code', 'attendanceNo'], '员工资源级默认副行字段')
eq(resolveSource({ resource: 'hrEmployees', searchFields: ['name'] })!.searchFields, ['name'], 'config 覆盖资源级默认')
eq(
  resolveSource({ resource: 'sysUsers', labelField: 'username', searchFields: ['username', 'name'], fields: ['name'], pageSize: 50 }, ref)!.resource,
  'sysUsers',
  'config 覆盖 ref'
)
eq(resolveSource({ searchFields: [] }, ref)!.searchFields, ['name'], '空 searchFields 回落 labelField')
eq(resolveSource({}), null, '无 resource 为 null')
eq(resolveSource({ labelField: 'label' }, ref)!.sortField, 'label', 'sortField 默认回落 labelField')
eq(resolveSource({ labelField: 'label', sortField: 'dueDate' }, ref)!.sortField, 'dueDate', 'sortField 显式覆盖')

eq(
  resolveSource({ filterState: { enabled: { kind: 'bool', eq: true } } }, ref)!.filterState,
  { enabled: { kind: 'bool', eq: true } },
  '保留结构化固定筛选'
)

// resolveFkTarget：普通 fk 取资源配置；多态按行判别值选变体；解析不了为 null。
const id = '11111111-1111-1111-1111-111111111111'
const polyRef = {
  resource: null,
  relation: null,
  labelField: null,
  discriminator: 'partyType',
  variants: [
    { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
    { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
  ],
}
eq(resolveFkTarget(ref, { id }), { resource: 'basCompanies', labelField: 'name' }, '普通 fk 取自身')
eq(resolveFkTarget(polyRef, { id, partyType: 'SUPPLIER' }), { resource: 'purSuppliers', labelField: 'name' }, '多态按判别值选变体')
eq(resolveFkTarget(polyRef, { id, partyType: null }), null, '判别值为空解析不了')
eq(resolveFkTarget(polyRef, { id, partyType: 'EMPLOYEE' }), null, '未知判别值解析不了')

const voucherRef = {
  resource: null,
  relation: null,
  labelField: null,
  discriminator: 'voucherType',
  variants: [{ value: 'acc.gl_journal', resource: 'accGlJournals', labelField: 'voucherNo', label: '凭证' }],
}
eq(resolveFkTarget(voucherRef, { id, voucherType: 'acc.gl_journal' }), { resource: 'accGlJournals', labelField: 'voucherNo' }, '字符串判别值原样匹配变体')
eq(resolveFkTarget({ resource: null, relation: null, labelField: null }, { id }), null, '普通 fk 无 resource 为 null')

const source = resolveSource({ searchFields: ['name', 'code'] }, ref)!
eq(optionLabel(source, { id, name: '集团总部' } as unknown as Row), '集团总部', 'label 字段')
eq(optionLabel(source, { id, name: null } as unknown as Row), '11111111', 'label 缺失退截断 id')
eq(optionLabel(source, null), '', '空行为空串')

console.log('remote-select-checks ok')
