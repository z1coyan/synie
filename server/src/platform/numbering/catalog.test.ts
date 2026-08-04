import { describe, expect, test } from 'bun:test'
import frozenCatalog from '../../../test/fixtures/numberables.json'
import { createPlatformRegistry } from '../../../test/helpers.ts'
import { createRegistry } from '../meta/registry.ts'
import type { ResourceMeta } from '../meta/types.ts'
import { buildNumberingCatalog, type CatalogField } from './catalog.ts'

interface FrozenResource {
  prefix: string
  grid: string
  fields: CatalogField[]
}

/**
 * 特征化豁免清单：旧 numberables.json 中确凿陈旧/错误、允许派生结果不再包含的
 * (prefix, path)。加入前必须注明原因。当前为空。
 */
const EXEMPT_PATHS = new Set<string>([])

describe('编号字段目录（Registry 派生）', () => {
  const catalog = buildNumberingCatalog(createPlatformRegistry())
  const frozen = frozenCatalog as FrozenResource[]

  test('特征化：派生目录是冻结目录（numberables.json fixture）的超集', () => {
    // DB 中的编号规则按 (prefix, path) 引用目录字段：旧 path 一个都不能丢，
    // sourceField/type/lookup 必须逐一一致（label 允许随 Meta 演进）。
    expect(frozen.length).toBe(25)
    for (const old of frozen) {
      const derived = catalog.resource(old.prefix)
      expect(derived, `缺少旧资源 ${old.prefix}`).toBeDefined()
      expect(derived!.grid).toBe(old.grid)
      for (const oldField of old.fields) {
        if (EXEMPT_PATHS.has(`${old.prefix}/${oldField.path}`)) continue
        const derivedField = derived!.byPath.get(oldField.path)
        expect(derivedField, `缺少旧字段 ${old.prefix}/${oldField.path}`).toBeDefined()
        expect(derivedField!.sourceField).toBe(oldField.sourceField)
        expect(derivedField!.type).toBe(oldField.type)
        expect(derivedField!.lookup ?? null).toEqual(oldField.lookup ?? null)
      }
    }
  })

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

  test('invMaterials 编号 prefix 钉住旧串 inv.material（权限码已改名 base.material，DB 规则未迁移）', () => {
    expect(catalog.resource('inv.material')?.grid).toBe('invMaterials')
    expect(catalog.resource('base.material')).toBeUndefined()
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
      table: 'demo_empty',
      numbering: true,
      fields: [scalar('id'), scalar('inserted_at'), scalar('updated_at')],
      actions: read,
    })
    registry.seal()
    expect(() => buildNumberingCatalog(registry)).toThrow('派生不出编号字段')
  })

  test('普通 fk 一层展开产出 lookup，多态 fk 保留原始 ID 列', () => {
    const registry = createRegistry()
    registry.register({
      name: 'demoCompanies',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.company',
      permissionLabel: '演示公司',
      table: 'demo_company',
      fields: [scalar('id'), scalar('code', '编号'), scalar('name', '名称')],
      actions: read,
    })
    registry.register({
      name: 'demoDocs',
      classification: { presentation: 'none', interactive: false },
      permissionPrefix: 'demo.doc',
      permissionLabel: '演示单据',
      table: 'demo_doc',
      numbering: true,
      fields: [
        scalar('id'),
        scalar('doc_no', '单据编号'),
        {
          name: 'party_type', apiName: 'partyType', dbColumn: 'party_type', type: 'enum',
          label: '对手类型', enumOptions: [{ value: 'COMPANY', label: '公司' }],
        },
        {
          name: 'party_id', apiName: 'partyId', dbColumn: 'party_id', type: 'fk', label: '对手',
          ref: {
            resource: null, relation: null, labelField: null,
            discriminator: 'partyType', discriminatorType: 'enum',
            variants: [
              { value: 'COMPANY', resource: 'demoCompanies', labelField: 'name', label: '公司' },
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
      'company.code',
      'company.name',
    ])
    expect(resource.byPath.get('party_id')).toEqual({
      path: 'party_id', label: '对手', type: 'fk', sourceField: 'party_id',
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
