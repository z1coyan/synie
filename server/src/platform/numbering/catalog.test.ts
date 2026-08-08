import { describe, expect, test } from 'bun:test'
import { createPlatformRegistry } from '../../../test/helpers.ts'
import { createRegistry } from '../meta/registry.ts'
import type { ResourceMeta } from '../meta/types.ts'
import { buildNumberingCatalog } from './catalog.ts'

describe('编号字段目录（Registry 派生）', () => {
  const catalog = buildNumberingCatalog(createPlatformRegistry())

  test('publicResources 只暴露 path/label/type（wire 契约）', () => {
    const resources = catalog.publicResources()
    expect(resources.length).toBeGreaterThanOrEqual(25)
    for (const resource of resources) {
      expect(resource.prefix).toBeTruthy()
      expect(resource.grid).toBeTruthy()
      expect(resource.fields.length).toBeGreaterThan(0)
      for (const field of resource.fields) {
        expect(Object.keys(field).sort()).toEqual(['label', 'path', 'type'])
      }
    }
  })

  test('未声明 numbering 的资源不进目录', () => {
    expect(catalog.resource('base.company')).toBeUndefined()
    expect(catalog.resource('sys.user')).toBeUndefined()
  })

  test('invMaterials 编号 prefix 即权限前缀 base.material', () => {
    expect(catalog.resource('base.material')?.grid).toBe('invMaterials')
    expect(catalog.resource('inv.material')).toBeUndefined()
  })
})

describe('编号字段目录 fail-closed', () => {
  function scalar(name: string, label = name): ResourceMeta['fields'][number] {
    return { name, apiName: name, dbColumn: name, type: 'string', label }
  }
  const read: ResourceMeta['actions'] = [{ key: 'read', label: '查看', scope: 'both' }]

  test('同一权限前缀重复声明 numbering 启动报错', () => {
    const registry = createRegistry()
    registry.register({
      name: 'demoHeads',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.doc',
      permissionLabel: '演示单据',
      authz: { kind: 'global' },
      table: 'demo_head',
      numbering: true,
      fields: [scalar('id'), scalar('doc_no')],
      actions: read,
    })
    registry.register({
      name: 'demoItems',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.doc',
      permissionLabel: '演示单据',
      authz: { kind: 'global' },
      table: 'demo_item',
      numbering: true,
      fields: [scalar('id'), scalar('item_no')],
      actions: read,
    })
    registry.seal()
    expect(() => buildNumberingCatalog(registry)).toThrow('编号字段目录重复资源: demo.doc')
  })

  test('声明 numbering 但派生不出字段时启动报错', () => {
    const registry = createRegistry()
    registry.register({
      name: 'demoEmpties',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.empty',
      permissionLabel: '演示空单',
      authz: { kind: 'global' },
      table: 'demo_empty',
      numbering: true,
      fields: [scalar('id'), scalar('inserted_at'), scalar('updated_at')],
      actions: read,
    })
    registry.seal()
    expect(() => buildNumberingCatalog(registry)).toThrow('派生不出编号字段')
  })

  test('普通 fk 一层展开产出 lookup；多态 fk 保留 ID 并展开共有标量', () => {
    const registry = createRegistry()
    registry.register({
      name: 'demoCompanies',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.company',
      permissionLabel: '演示公司',
      authz: { kind: 'global' },
      table: 'demo_company',
      fields: [scalar('id'), scalar('code', '编号'), scalar('name', '名称')],
      actions: read,
    })
    registry.register({
      name: 'demoCustomers',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.customer',
      permissionLabel: '演示客户',
      authz: { kind: 'global' },
      table: 'demo_customer',
      fields: [scalar('id'), scalar('code', '客户编号'), scalar('name', '客户名称')],
      actions: read,
    })
    registry.register({
      name: 'demoDocs',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.doc',
      permissionLabel: '演示单据',
      authz: { kind: 'company' },
      table: 'demo_doc',
      numbering: true,
      fields: [
        scalar('id'),
        scalar('doc_no', '单据编号'),
        {
          name: 'party_type', apiName: 'partyType', dbColumn: 'party_type', type: 'enum',
          label: '对手类型', enumOptions: [
            { value: 'COMPANY', label: '公司' },
            { value: 'CUSTOMER', label: '客户' },
          ],
        },
        {
          name: 'party_id', apiName: 'partyId', dbColumn: 'party_id', type: 'fk', label: '对手',
          ref: {
            resource: null, relation: null, labelField: null,
            discriminator: 'partyType', discriminatorType: 'enum',
            variants: [
              { value: 'COMPANY', resource: 'demoCompanies', labelField: 'name', label: '公司' },
              { value: 'CUSTOMER', resource: 'demoCustomers', labelField: 'name', label: '客户' },
            ],
          },
        },
        {
          name: 'company_id', apiName: 'companyId', dbColumn: 'company_id', type: 'fk', label: '公司',
          ref: { resource: 'demoCompanies', relation: 'company', labelField: 'name' },
        },
      ],
      actions: read,
    })
    registry.seal()
    const catalog = buildNumberingCatalog(registry)
    const resource = catalog.resource('demo.doc')!
    expect(resource.fields.map((f) => f.path)).toEqual([
      'doc_no',
      'party_type',
      'party_id',
      'party.code',
      'party.name',
      'company.code',
      'company.name',
    ])
    expect(resource.byPath.get('party_id')).toEqual({
      path: 'party_id', label: '对手', type: 'fk', sourceField: 'party_id',
    })
    // 各变体 code 标签不同 → 统一「编号」
    expect(resource.byPath.get('party.code')).toEqual({
      path: 'party.code',
      label: '对手·编号',
      type: 'string',
      sourceField: 'party_id',
      polyLookup: {
        discriminatorField: 'party_type',
        variants: [
          { value: 'COMPANY', table: 'demo_company', valueColumn: 'code' },
          { value: 'CUSTOMER', table: 'demo_customer', valueColumn: 'code' },
        ],
      },
    })
    expect(resource.byPath.get('company.code')).toEqual({
      path: 'company.code',
      label: '公司·编号',
      type: 'string',
      sourceField: 'company_id',
      lookup: { table: 'demo_company', valueColumn: 'code' },
    })
  })
})
