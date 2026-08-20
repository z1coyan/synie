import { describe, expect, test } from 'bun:test'
import { ApiError } from '../http/errors.ts'
import { createRegistry } from '../meta/registry.ts'
import type { ResourceMeta } from '../meta/types.ts'
import { createFieldCatalog } from './catalog.ts'
import { createPlatformRegistry } from '../../../test/helpers.ts'

function scalar(name: string): ResourceMeta['fields'][number] {
  return { name, apiName: name, dbColumn: name, type: 'string', label: name }
}

function newTestCatalog() {
  const company = 'basCompanies'
  const material = 'invMaterials'
  const companyRel = 'company'
  const materialRel = 'material'
  const name = 'name'
  const discriminator = 'partyType'
  const discriminatorType = 'enum' as const
  const partyVariants = [
    { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
    { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
  ]
  const registry = createRegistry()
  registry.register({
    name: 'basCompanies',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'base.company',
    permissionLabel: '公司',
    authz: { kind: 'global' },
    table: 'bas_company',
    fields: [
      scalar('id'),
      scalar('code'),
      scalar('name'),
      scalar('short_name'),
      scalar('inserted_at'),
      scalar('updated_at'),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'invMaterials',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'base.material',
    permissionLabel: '物料',
    authz: { kind: 'global' },
    table: 'inv_material',
    fields: [scalar('id'), scalar('code'), scalar('name')],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'salOrders',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'sales.order',
    permissionLabel: '销售订单',
    authz: { kind: 'global' },
    table: 'sal_order',
    fields: [
      scalar('id'),
      scalar('order_no'),
      scalar('status'),
      scalar('inserted_at'),
      scalar('updated_at'),
      {
        name: 'gross_total',
        apiName: 'grossTotal',
        dbColumn: 'gross_total',
        type: 'decimal',
        label: '总额',
        calculated: true,
      },
      {
        name: 'api_secret',
        apiName: 'apiSecret',
        dbColumn: 'api_secret',
        type: 'string',
        label: '密钥',
        sensitive: true,
      },
      {
        name: 'company_id',
        apiName: 'companyId',
        dbColumn: 'company_id',
        type: 'fk',
        label: '公司',
        ref: { resource: company, relation: companyRel, labelField: name },
      },
      {
        name: 'party_id',
        apiName: 'partyId',
        dbColumn: 'party_id',
        type: 'fk',
        label: '对手',
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator,
          discriminatorType,
          variants: partyVariants,
        },
      },
    ],
    printHead: true,
    printLoops: [{ name: 'items', resource: 'salOrderItems' }],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'salOrderItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'sales.order',
    permissionLabel: '销售订单',
    authz: { kind: 'global' },
    table: 'sal_order_item',
    fields: [
      scalar('id'),
      scalar('qty'),
      scalar('amount'),
      scalar('material_name'),
      scalar('unit_name'),
      {
        name: 'material_id',
        apiName: 'materialId',
        dbColumn: 'material_id',
        type: 'fk',
        label: '物料',
        ref: { resource: material, relation: materialRel, labelField: name },
      },
      {
        name: 'party_id',
        apiName: 'partyId',
        dbColumn: 'party_id',
        type: 'fk',
        label: '对手',
        printRawId: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator,
          discriminatorType,
          variants: partyVariants,
        },
      },
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'salQuotations',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'sales.quotation',
    permissionLabel: '销售报价',
    authz: { kind: 'company' },
    table: 'sal_quotation',
    fields: [
      scalar('id'),
      scalar('quotation_no'),
      {
        name: 'company_id',
        apiName: 'companyId',
        dbColumn: 'company_id',
        type: 'fk',
        label: '公司',
        ref: { resource: company, relation: companyRel, labelField: name },
      },
    ],
    printHead: true,
    printLoops: [{ name: 'items', resource: 'salQuotationItems' }],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'salQuotationItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'sales.quotation',
    permissionLabel: '销售报价',
    authz: { kind: 'global' },
    table: 'sal_quotation_item',
    fields: [scalar('id'), scalar('qty')],
    printLoops: [{ name: 'tiers', resource: 'salQuotationTiers' }],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'salQuotationTiers',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'sales.quotation',
    permissionLabel: '销售报价',
    authz: { kind: 'global' },
    table: 'sal_quotation_tier',
    fields: [scalar('id'), scalar('price')],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  registry.register({
    name: 'xProjection',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'x.projection',
    permissionLabel: '投影',
    authz: { kind: 'global', readAnyOf: ['sales.order:read'] },
    table: 'x_projection',
    fields: [scalar('id'), scalar('note')],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  })
  return createFieldCatalog(registry)
}

describe('FieldCatalog', () => {
  test('derives fields from meta registry', () => {
    const catalog = newTestCatalog()
    const resources = catalog.resources()
    expect(resources).toContain('sales.order')
    expect(resources).toContain('base.company')
    expect(resources).not.toContain('x.projection')

    const order = catalog.get('sales.order')
    expect(order).toBeDefined()
    const names = order!.fields.map((f) => f.name)
    for (const name of [
      'order_no',
      'status',
      'gross_total',
      'company.name',
      'company.code',
      'party.name',
    ]) {
      expect(names).toContain(name)
    }
    for (const excluded of ['id', 'inserted_at', 'company_id', 'party_id', 'api_secret']) {
      expect(names).not.toContain(excluded)
    }
    const items = order!.loops.find((l) => l.name === 'items')
    expect(items).toBeDefined()
    expect(items!.fields.map((f) => f.name)).toContain('material_name')
    expect(items!.fields.map((f) => f.name)).toContain('material.name')
    expect(items!.fields.map((f) => f.name)).toContain('party_id')

    const quotation = catalog.get('sales.quotation')
    const qItems = quotation!.loops.find((l) => l.name === 'items')
    expect(qItems?.nestedLoops).toEqual(['tiers'])
  })

  test('validatePlaceholders names unknown fields in Chinese', () => {
    const catalog = newTestCatalog()
    try {
      catalog.validatePlaceholders('sales.order', {
        fields: ['order_no', 'nope'],
        nested: {
          items: ['qty', 'bad'],
          deep: ['a.b'],
        },
      })
      throw new Error('expected validation error')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      const message = (err as ApiError).message
      expect(message).toContain('未知头字段')
      expect(message).toContain('nope')
      expect(message).toContain('未知循环区字段')
      expect(message).toContain('items.bad')
    }
  })

  test('validatePlaceholders matches Go golden classification message', () => {
    const catalog = newTestCatalog()
    catalog.validatePlaceholders('sales.order', {
      fields: ['order_no', 'party.name'],
      nested: {
        company: ['name'],
        items: ['_seq', 'qty', 'material.name'],
      },
    })

    try {
      catalog.validatePlaceholders('sales.quotation', {
        fields: ['id', 'old_flat_key'],
        nested: {
          company: ['address.city', 'unknown'],
          items: ['tiers.qty', 'unknown'],
        },
      })
      throw new Error('expected validation error')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('validation')
      // 与 server-go catalog_test.go TestValidatePlaceholdersMatchesLegacyClassification 文案一致
      expect((err as ApiError).message).toBe(
        '未知头字段: company.unknown, id, old_flat_key；未知循环区字段: items.unknown；关联路径只支持一层: company.address.city；不支持嵌套循环: items.tiers',
      )
    }

    try {
      catalog.validatePlaceholders('not.real', { fields: [], nested: {} })
      throw new Error('expected validation error')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toBe('不支持的资源类型 not.real')
    }
  })

  test('returns copies and rejects PrintRawID party.name expansion', () => {
    const catalog = newTestCatalog()
    const first = catalog.get('sales.order')!
    first.fields[0]!.name = 'mutated'
    first.loops[0]!.fields[0]!.name = 'mutated'
    const second = catalog.get('sales.order')!
    expect(second.fields[0]!.name).not.toBe('mutated')
    expect(second.loops[0]!.fields[0]!.name).not.toBe('mutated')
    const items = second.loops.find((l) => l.name === 'items')!
    expect(items.fields.map((f) => f.name)).not.toContain('party.name')
    expect(items.nestedLoops ?? []).toEqual([])
  })

  test('real platform registry derives catalog covering every print head', () => {
    const registry = createPlatformRegistry()
    const catalog = createFieldCatalog(registry)
    const resources = catalog.resources()
    expect(resources).toContain('sales.order')
    expect(resources).toContain('sys.print_template')
    expect(resources).toContain('acc.ar_ap')
    const arAp = catalog.get('acc.ar_ap')
    expect(arAp?.loops.map((l) => l.name).sort()).toEqual(['ledger', 'rows'])
    for (const name of ['as_of', 'perspective', 'exported_at', 'company.name']) {
      expect(arAp!.fields.map((f) => f.name)).toContain(name)
    }
    // 与打印头规则对拍：无 authz.readAnyOf 的资源按权限前缀去重，随注册表增减自动跟随
    const expectedHeads = new Set(
      registry
        .list()
        .filter((r) => !(r.authz?.readAnyOf && r.authz.readAnyOf.length > 0))
        .map((r) => r.permissionPrefix),
    )
    expect(new Set(resources)).toEqual(expectedHeads)
    const order = catalog.get('sales.order')
    expect(order?.loops.map((l) => l.name)).toContain('items')
    for (const name of [
      'order_no',
      'status',
      'gross_total',
      'company.name',
      'company.code',
      'party.name',
    ]) {
      expect(order!.fields.map((f) => f.name)).toContain(name)
    }
  })
})
