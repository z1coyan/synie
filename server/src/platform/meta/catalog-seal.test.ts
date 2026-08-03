import { describe, expect, test } from 'bun:test'
import { createRegistry } from './registry.ts'
import { createSealedResourceRegistry, registerAllResources } from './register-all.ts'
import { currencyResourceMeta, companyResourceMeta } from '~/modules/base/meta.ts'
import type { Actor } from '../authz/actor.ts'
import { decodeResourceDocument } from '@synie/shared'
import {
  assertClassificationCoverage,
  RESOURCE_CLASSIFICATION,
} from './resource-classification.ts'

const superAdmin: Actor = {
  userId: 'u',
  username: 'admin',
  name: null,
  superAdmin: true,
  allCompanies: true,
  permissions: new Set(),
  companyIds: [],
}

describe('Resource Catalog seal 与 v2 投影', () => {
  test('全部基线资源可规范化并 seal', () => {
    const registry = createRegistry()
    registerAllResources(registry)
    expect(registry.isSealed()).toBe(false)
    const report = registry.seal()
    expect(registry.isSealed()).toBe(true)
    expect(report.total).toBe(102)
    expect(report.normalized).toBe(102)
  })

  test('seal 后禁止继续注册', () => {
    const registry = createSealedResourceRegistry()
    expect(() => registry.register(currencyResourceMeta())).toThrow(/已 seal/)
  })

  test('Meta 响应仅为 ResourceDocument v2 envelope', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    expect(doc.schemaVersion).toBe(2)
    expect(doc.name).toBe('basCurrencies')
    const catalog = decodeResourceDocument(doc)
    expect(catalog.label).toBe('货币')
    expect(catalog.permissionPrefix).toBe('base.currency')
    expect(catalog.form.kind).toBe('basic')
    expect(catalog.capabilities).toEqual(
      expect.arrayContaining(['create', 'update', 'delete']),
    )
    // 无 v1 grid/form sibling
    expect(!('grid' in doc)).toBe(true)
    expect(!('catalog' in doc)).toBe(true)
  })

  test('无目标读取权：reference targetUnavailable，basic 布局剔除可编辑外键', () => {
    const registry = createSealedResourceRegistry()
    const actor: Actor = {
      userId: 'u',
      username: 'co',
      name: null,
      superAdmin: false,
      allCompanies: true,
      permissions: new Set(['base.company:read', 'base.company:create', 'base.company:update']),
      companyIds: [],
    }
    const doc = registry.buildDocument('basCompanies', actor)
    const catField = doc.fields.find((f) => f.name === 'baseCurrencyId')
    expect(catField?.kind).toBe('reference')
    if (catField?.kind === 'reference') {
      expect(catField.targetUnavailable).toBe(true)
    }
    if (doc.form.kind === 'basic') {
      const placed = doc.form.layout.fields?.map((p) => p.field) ?? []
      expect(placed).not.toContain('baseCurrencyId')
    }
  })

  test('list 列仅含 readable 字段', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    for (const name of doc.list.columns) {
      const field = doc.fields.find((f) => f.name === name)!
      expect(field.visibility).toBe('readable')
    }
  })

  test('commands 使用语义 key，target 正确且不含 v1 transport', () => {
    const registry = createSealedResourceRegistry()
    const recon = registry.buildDocument('accBankTransactions', superAdmin)
    const reconCmd = recon.commands.find((c) => c.key === 'reconcile')
    expect(reconCmd).toMatchObject({
      key: 'reconcile',
      target: 'row',
      requiredCapability: 'reconcile',
    })
    expect(recon.commands.every((c) => !('http' in c) && !('mutation' in c))).toBe(true)
    // 服务端定义仍可用 disguise key + permissionAction 声明语义
    expect(
      registry.get('accBankTransactions')!.actions.some(
        (a) => a.key === 'export' && a.permissionAction === 'reconcile',
      ),
    ).toBe(true)

    const days = registry.buildDocument('hrAttendanceDays', superAdmin)
    const recalcCmd = days.commands.find((c) => c.key === 'recalc')
    expect(recalcCmd).toMatchObject({
      key: 'recalc',
      target: 'collection',
      requiredCapability: 'recalc',
    })

    const storage = registry.buildDocument('sysStorages', superAdmin)
    const setDefaultCmd = storage.commands.find((c) => c.key === 'setDefault')
    expect(setDefaultCmd).toMatchObject({
      key: 'setDefault',
      target: 'row',
      requiredCapability: 'update',
    })
  })

  test('标准 CRUD 不进入 commands，只贡献 capabilities', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    expect(doc.commands).toEqual([])
    expect(doc.capabilities).toEqual(expect.arrayContaining(['create', 'update', 'delete']))
  })

  test('basic FormMeta 不得重复 required/edit/label 字段事实', () => {
    const registry = createRegistry()
    const broken = currencyResourceMeta()
    broken.form!.fields!.name = {
      ...broken.form!.fields!.name,
      required: true,
    }
    expect(() => registry.register(broken)).toThrow(/重复字段事实: required/)
  })

  test('FormMeta 字段引用在注册期 fail-closed', () => {
    const registry = createRegistry()
    const broken = currencyResourceMeta()
    broken.form!.fields!.notAField = { placeholder: 'typo' }
    expect(() => registry.register(broken)).toThrow(
      /form\.fields 引用未知字段: notAField/,
    )
  })

  test('basic FormMeta order 只控制布局顺序', () => {
    const registry = createRegistry()
    const meta = currencyResourceMeta()
    meta.form!.fields!.name = { ...meta.form!.fields!.name, order: -10 }
    meta.form!.fields!.isoCode = { ...meta.form!.fields!.isoCode, order: -20 }
    registry.register(meta)
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    expect(doc.form.kind).toBe('basic')
    if (doc.form.kind === 'basic') {
      expect(doc.form.layout.fields?.slice(0, 2).map((field) => field.field)).toEqual([
        'isoCode',
        'name',
      ])
    }
  })

  test('断裂外键引用在 seal 时失败', () => {
    const registry = createRegistry()
    registry.register(currencyResourceMeta())
    const broken = companyResourceMeta()
    broken.fields = broken.fields.map((f) =>
      f.apiName === 'baseCurrencyId'
        ? {
            ...f,
            ref: { resource: 'notExist', relation: 'x', labelField: 'name' },
          }
        : f,
    )
    registry.register(broken)
    expect(() => registry.seal()).toThrow(/未知资源: notExist/)
  })

  test('单位 catalog：label=单位，enum/decimal/initial/span', () => {
    const registry = createSealedResourceRegistry()
    const catalog = decodeResourceDocument(registry.buildDocument('basUnits', superAdmin))
    expect(catalog.label).toBe('单位')
    expect(catalog.form.kind).toBe('basic')
    const unitType = catalog.fields.find((f) => f.name === 'unitType')
    expect(unitType?.kind).toBe('enum')
    const ratio = catalog.fields.find((f) => f.name === 'ratio')
    expect(ratio?.kind).toBe('scalar')
    if (ratio?.kind === 'scalar') expect(ratio.scalarType).toBe('decimal')
    expect(ratio?.input.initial).toBe(1)
    if (catalog.form.kind === 'basic') {
      const name = catalog.form.layout.fields?.find((p) => p.field === 'name')
      expect(name?.placeholder).toBe('如 千克')
      expect(name?.span).toBe(6)
      const symbol = catalog.form.layout.fields?.find((p) => p.field === 'symbol')
      expect(symbol?.span).toBe(6)
    }
  })

  test('供应商 catalog：basic 纯标量布局', () => {
    const registry = createSealedResourceRegistry()
    const catalog = decodeResourceDocument(registry.buildDocument('purSuppliers', superAdmin))
    expect(catalog.label).toBe('供应商')
    expect(catalog.form.kind).toBe('basic')
    if (catalog.form.kind === 'basic') {
      const placed = catalog.form.layout.fields?.map((p) => p.field) ?? []
      expect(placed).toEqual(expect.arrayContaining(['code', 'name', 'shortName']))
      expect(placed).not.toContain('id')
    }
  })

  test('公司 catalog：本币 filterState 与自引用外键', () => {
    const registry = createSealedResourceRegistry()
    const catalog = decodeResourceDocument(registry.buildDocument('basCompanies', superAdmin))
    expect(catalog.label).toBe('公司')
    expect(catalog.form.kind).toBe('basic')
    const baseCurrency = catalog.fields.find((f) => f.name === 'baseCurrencyId')
    expect(baseCurrency?.kind).toBe('reference')
    if (baseCurrency?.kind === 'reference') {
      expect(baseCurrency.targetResource).toBe('basCurrencies')
      expect(baseCurrency.filterState).toEqual({ active: { kind: 'bool', eq: true } })
      expect(baseCurrency.targetUnavailable).toBeFalsy()
    }
    const parent = catalog.fields.find((f) => f.name === 'parentId')
    expect(parent?.kind).toBe('reference')
    if (parent?.kind === 'reference') {
      expect(parent.targetResource).toBe('basCompanies')
    }
    if (catalog.form.kind === 'basic') {
      const code = catalog.form.layout.fields?.find((p) => p.field === 'code')
      expect(code?.placeholder).toBe('两位英文字母,如 SH')
    }
  })

  test('客户 catalog：form.kind=basic（同供应商先例）', () => {
    const registry = createSealedResourceRegistry()
    const catalog = decodeResourceDocument(registry.buildDocument('salCustomers', superAdmin))
    expect(catalog.label).toBe('客户')
    expect(catalog.form.kind).toBe('basic')
    if (catalog.form.kind === 'basic') {
      const placed = catalog.form.layout.fields?.map((p) => p.field) ?? []
      expect(placed).toEqual(expect.arrayContaining(['code', 'name', 'shortName']))
      expect(placed).not.toContain('id')
    }
  })

  test('发票 catalog：form.kind=extension（OCR Presentation Extension）', () => {
    const registry = createSealedResourceRegistry()
    const catalog = decodeResourceDocument(registry.buildDocument('accVatInvoices', superAdmin))
    expect(catalog.form.kind).toBe('extension')
    const wire = JSON.stringify(catalog)
    expect(wire).not.toMatch(/function\s*\(|=>|componentPath|script/)
  })

  test('销售发货 catalog：form.kind=extension（聚合草稿 Presentation Extension）', () => {
    const registry = createSealedResourceRegistry()
    const catalog = decodeResourceDocument(registry.buildDocument('salDeliveries', superAdmin))
    expect(catalog.form.kind).toBe('extension')
  })

  test('分类表覆盖全部资源；无 legacy normalizer 模块', () => {
    const registry = createRegistry()
    registerAllResources(registry)
    registry.seal()
    assertClassificationCoverage(registry.list().map((r) => r.name))
    expect(Object.keys(RESOURCE_CLASSIFICATION).length).toBe(102)

    for (const [name, expected] of [
      ['hrEmployees', ['name', 'code', 'attendanceNo']],
      ['invMaterials', ['name', 'code', 'spec']],
      ['invMaterialCategories', ['name', 'code']],
      ['basUnits', ['name', 'symbol']],
    ] as const) {
      const catalog = decodeResourceDocument(registry.buildDocument(name, superAdmin))
      expect(catalog.lookup.searchFields).toEqual([...expected])
      expect(catalog.lookup.subtitleFields?.length).toBeGreaterThan(0)
    }

    expect(decodeResourceDocument(registry.buildDocument('basAccounts', superAdmin)).form.kind).toBe(
      'extension',
    )
    expect(decodeResourceDocument(registry.buildDocument('hrEmployees', superAdmin)).form.kind).toBe(
      'extension',
    )
    expect(decodeResourceDocument(registry.buildDocument('invMaterials', superAdmin)).form.kind).toBe(
      'extension',
    )
    expect(
      decodeResourceDocument(registry.buildDocument('invMaterialCategories', superAdmin)).form.kind,
    ).toBe('basic')
    const stockEntries = decodeResourceDocument(registry.buildDocument('invStockEntries', superAdmin))
    expect(stockEntries.form.kind).toBe('none')
    expect(stockEntries.fields.find((field) => field.name === 'quantity')?.label).toBe('数量')
  })
})
