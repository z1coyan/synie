import { describe, expect, test } from 'bun:test'
import { createRegistry } from './registry.ts'
import { createSealedResourceRegistry, registerAllResources } from './register-all.ts'
import { currencyResourceMeta, companyResourceMeta } from '~/modules/base/meta.ts'
import type { Actor } from '../authz/actor.ts'
import { decodeResourceDocument } from '@synie/shared'
import {
  getLegacyNormalizerCallCount,
  resetLegacyNormalizerCallCountForTests,
} from './legacy-normalize.ts'
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

describe('Resource Catalog seal 与双投影', () => {
  test('全部基线资源可 seal，报告 typed 全覆盖（legacy 调用归零）', () => {
    const registry = createRegistry()
    registerAllResources(registry)
    expect(registry.isSealed()).toBe(false)
    const report = registry.seal()
    expect(registry.isSealed()).toBe(true)
    expect(report.total).toBe(97)
    expect(report.legacy).toBe(0)
    expect(report.typed).toBe(97)
  })

  test('seal 后禁止继续注册', () => {
    const registry = createSealedResourceRegistry()
    expect(() => registry.register(currencyResourceMeta())).toThrow(/已 seal/)
  })

  test('Meta 响应同时承载 v1 grid/form 与 v2 catalog', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    expect(doc.name).toBe('basCurrencies')
    expect(doc.grid.columns.some((c) => c.name === 'isoCode')).toBe(true)
    expect(doc.form?.fields?.isoCode).toMatchObject({ edit: 'createOnly' })
    expect(doc.catalog).toBeDefined()
    const catalog = decodeResourceDocument(doc.catalog)
    expect(catalog.label).toBe('货币')
    expect(catalog.permissionPrefix).toBe('base.currency')
    expect(catalog.form.kind).toBe('basic')
    expect(catalog.capabilities).toEqual(
      expect.arrayContaining(['create', 'update', 'delete']),
    )
  })

  test('Grid 与 catalog 字段事实同源（非手工双写）', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    const gridNames = doc.grid.columns.map((c) => c.name).sort()
    const catalogNames = doc.catalog!.fields.map((f) => f.name).sort()
    expect(catalogNames).toEqual(gridNames)
    for (const col of doc.grid.columns) {
      const field = doc.catalog!.fields.find((f) => f.name === col.name)!
      expect(field.label).toBe(col.label)
    }
  })

  test('无目标读取权：Grid 降级 ID，catalog form 不含可编辑外键', () => {
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
    const baseCurrency = doc.grid.columns.find((c) => c.name === 'baseCurrencyId')
    expect(baseCurrency?.type).toBe('string')
    expect(baseCurrency?.ref).toBeNull()

    const catField = doc.catalog!.fields.find((f) => f.name === 'baseCurrencyId')
    expect(catField?.kind).toBe('reference')
    if (catField?.kind === 'reference') {
      expect(catField.targetUnavailable).toBe(true)
    }
    if (doc.catalog!.form.kind === 'basic') {
      const placed = doc.catalog!.form.layout.fields?.map((p) => p.field) ?? []
      expect(placed).not.toContain('baseCurrencyId')
    }
  })

  test('write-only / sensitive 不进入 list 列（sensitive 整字段剔除）', () => {
    // 现有资源无 writeOnly；验证 catalog list 仅含 readable
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    for (const name of doc.catalog!.list.columns) {
      const field = doc.catalog!.fields.find((f) => f.name === name)!
      expect(field.visibility).toBe('readable')
    }
  })

  test('v2 commands 使用语义 key（reconcile/recalc/setDefault），target 正确且不含 transport', () => {
    const registry = createSealedResourceRegistry()
    const recon = registry.buildDocument('accBankTransactions', superAdmin)
    const reconCmd = recon.catalog!.commands.find((c) => c.key === 'reconcile')
    expect(reconCmd).toMatchObject({
      key: 'reconcile',
      target: 'row',
      requiredCapability: 'reconcile',
    })
    expect(recon.catalog!.commands.every((c) => !('http' in c))).toBe(true)
    // v1 仍保留 export 伪装 key（工单 11 删除）
    expect(
      registry.get('accBankTransactions')!.actions.some(
        (a) => a.key === 'export' && a.permissionAction === 'reconcile',
      ),
    ).toBe(true)

    const days = registry.buildDocument('hrAttendanceDays', superAdmin)
    const recalcCmd = days.catalog!.commands.find((c) => c.key === 'recalc')
    expect(recalcCmd).toMatchObject({
      key: 'recalc',
      target: 'collection',
      requiredCapability: 'recalc',
    })

    const storage = registry.buildDocument('sysStorages', superAdmin)
    const setDefaultCmd = storage.catalog!.commands.find((c) => c.key === 'setDefault')
    expect(setDefaultCmd).toMatchObject({
      key: 'setDefault',
      target: 'row',
      requiredCapability: 'update',
    })
  })

  test('标准 CRUD 不进入 commands，只贡献 capabilities', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('basCurrencies', superAdmin)
    expect(doc.catalog!.commands).toEqual([])
    expect(doc.catalog!.capabilities).toEqual(
      expect.arrayContaining(['create', 'update', 'delete']),
    )
  })

  test('断裂外键引用在 seal 时失败', () => {
    const registry = createRegistry()
    registry.register(currencyResourceMeta())
    // company 引用 basCurrencies 已注册，但 parent 自引用 ok；再注册一个坏引用
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
    const doc = registry.buildDocument('basUnits', superAdmin)
    const catalog = decodeResourceDocument(doc.catalog)
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
    const doc = registry.buildDocument('purSuppliers', superAdmin)
    const catalog = decodeResourceDocument(doc.catalog)
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
    const doc = registry.buildDocument('basCompanies', superAdmin)
    const catalog = decodeResourceDocument(doc.catalog)
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

  test('客户 catalog：form.kind=extension（附件 Presentation Extension）', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('salCustomers', superAdmin)
    const catalog = decodeResourceDocument(doc.catalog)
    expect(catalog.label).toBe('客户')
    expect(catalog.form.kind).toBe('extension')
  })

  test('发票 catalog：form.kind=extension（OCR Presentation Extension）', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('accVatInvoices', superAdmin)
    const catalog = decodeResourceDocument(doc.catalog)
    expect(catalog.form.kind).toBe('extension')
    // ResourceDocument 无可执行脚本/组件路径
    const wire = JSON.stringify(catalog)
    expect(wire).not.toMatch(/function\s*\(|=>|componentPath|script/)
  })

  test('销售发货 catalog：form.kind=extension（聚合草稿 Presentation Extension）', () => {
    const registry = createSealedResourceRegistry()
    const doc = registry.buildDocument('salDeliveries', superAdmin)
    const catalog = decodeResourceDocument(doc.catalog)
    expect(catalog.form.kind).toBe('extension')
  })

  test('分类表覆盖全部资源；legacy normalizer 调用数为 0', () => {
    resetLegacyNormalizerCallCountForTests()
    const registry = createRegistry()
    registerAllResources(registry)
    registry.seal()
    assertClassificationCoverage(registry.list().map((r) => r.name))
    expect(Object.keys(RESOURCE_CLASSIFICATION).length).toBe(97)
    expect(getLegacyNormalizerCallCount()).toBe(0)

    // lookup：员工/物料/分类/单位
    for (const [name, expected] of [
      ['hrEmployees', ['name', 'code', 'attendanceNo']],
      ['invMaterials', ['name', 'code', 'spec']],
      ['invMaterialCategories', ['name', 'code']],
      ['basUnits', ['name', 'symbol']],
    ] as const) {
      const catalog = decodeResourceDocument(
        registry.buildDocument(name, superAdmin).catalog,
      )
      expect(catalog.lookup.searchFields).toEqual([...expected])
      expect(catalog.lookup.subtitleFields?.length).toBeGreaterThan(0)
    }

    // 呈现分类 → form.kind
    expect(
      decodeResourceDocument(registry.buildDocument('basAccounts', superAdmin).catalog).form.kind,
    ).toBe('extension')
    expect(
      decodeResourceDocument(registry.buildDocument('hrEmployees', superAdmin).catalog).form.kind,
    ).toBe('extension')
    expect(
      decodeResourceDocument(registry.buildDocument('invMaterials', superAdmin).catalog).form.kind,
    ).toBe('extension')
    expect(
      decodeResourceDocument(registry.buildDocument('invMaterialCategories', superAdmin).catalog).form
        .kind,
    ).toBe('basic')
    expect(
      decodeResourceDocument(registry.buildDocument('invStockEntries', superAdmin).catalog).form.kind,
    ).toBe('none')
  })
})
