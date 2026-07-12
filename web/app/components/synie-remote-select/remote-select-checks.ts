// bun app/components/synie-remote-select/remote-select-checks.ts 可直接运行的纯函数自检
import { buildByIdQuery, buildOptionsQuery, optionLabel, resolveFkTarget, resolveSource } from './remote-query'
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

// —— resolveSource:ref 提供默认,config 覆盖;都无 resource 为 null ——
eq(resolveSource({}, ref), {
  resource: 'basCompanies',
  labelField: 'name',
  searchFields: ['name'],
  filter: null,
  fields: [],
  pageSize: 20,
}, 'ref 默认值')
eq(
  resolveSource({ resource: 'sysUsers', labelField: 'username', searchFields: ['username', 'name'], filter: '{enabled: {eq: true}}', fields: ['name'], pageSize: 50 }, ref)!.resource,
  'sysUsers',
  'config 覆盖 ref'
)
eq(resolveSource({ searchFields: [] }, ref)!.searchFields, ['name'], '空 searchFields 回落 labelField')
eq(resolveSource({}), null, '无 resource 为 null')

const src = resolveSource({ searchFields: ['name', 'code'], filter: '{enabled: {eq: true}}' }, ref)!

// —— buildOptionsQuery:固定过滤 and 搜索 or;搜索词 JSON 转义;labelField 升序 ——
eq(
  buildOptionsQuery(src, '', 0),
  'query { basCompanies(limit: 20, offset: 0, sort: [{field: NAME, order: ASC}], filter: {enabled: {eq: true}}) { count results { id name } } }',
  '无搜索词只有固定过滤'
)
eq(
  buildOptionsQuery(src, ' 华东"x" ', 20),
  `query { basCompanies(limit: 20, offset: 20, sort: [{field: NAME, order: ASC}], filter: {and: [{enabled: {eq: true}}, {or: [{name: {contains: ${JSON.stringify('华东"x"')}}}, {code: {contains: ${JSON.stringify('华东"x"')}}}]}]}) { count results { id name } } }`,
  '搜索词 trim+转义,多字段 or'
)
eq(
  buildOptionsQuery(resolveSource({}, ref)!, 'a', 0),
  'query { basCompanies(limit: 20, offset: 0, sort: [{field: NAME, order: ASC}], filter: {name: {contains: "a"}}) { count results { id name } } }',
  '单条件不包 and/or'
)

// —— buildByIdQuery:去重 + uuid 白名单;全非法为 null ——
const u1 = '11111111-1111-1111-1111-111111111111'
const u2 = '22222222-2222-2222-2222-222222222222'
eq(
  buildByIdQuery(resolveSource({}, ref)!, [u1, u2, u1, 'DROP']),
  `query { basCompanies(limit: 2, offset: 0, filter: {id: {in: ["${u1}", "${u2}"]}}) { count results { id name } } }`,
  '回显反查批量 in'
)
eq(buildByIdQuery(resolveSource({}, ref)!, ['nope']), null, '全非法为 null')
eq(buildByIdQuery(resolveSource({ fields: ['code', 'name'] }, ref)!, [u1])!.includes('{ id name code }'), true, 'fields 去重合并')

// —— resolveFkTarget:普通 fk 取三件套;多态按行判别值选变体;解析不了为 null ——
const polyRef = {
  resource: null,
  relation: null,
  labelField: null,
  discriminator: 'partyType',
  variants: [
    { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name' },
    { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name' },
  ],
}
eq(resolveFkTarget(ref, { id: u1 }), { resource: 'basCompanies', labelField: 'name' }, '普通 fk 取自身')
eq(
  resolveFkTarget(polyRef, { id: u1, partyType: 'SUPPLIER' }),
  { resource: 'purSuppliers', labelField: 'name' },
  '多态按判别值选变体'
)
eq(resolveFkTarget(polyRef, { id: u1, partyType: null }), null, '判别值为空解析不了')
eq(resolveFkTarget(polyRef, { id: u1, partyType: 'EMPLOYEE' }), null, '未知判别值解析不了')
eq(resolveFkTarget({ resource: null, relation: null, labelField: null }, { id: u1 }), null, '普通 fk 无 resource 为 null')

// —— optionLabel ——
eq(optionLabel(src, { id: u1, name: '集团总部' } as unknown as Row), '集团总部', 'label 字段')
eq(optionLabel(src, { id: u1, name: null } as unknown as Row), '11111111', 'label 缺失退截断 id')
eq(optionLabel(src, null), '', '空行为空串')

console.log('remote-select-checks ok')
