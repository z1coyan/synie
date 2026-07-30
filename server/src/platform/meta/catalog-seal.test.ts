import { describe, expect, test } from 'bun:test'
import { createRegistry } from './registry.ts'
import { createSealedResourceRegistry, registerAllResources } from './register-all.ts'
import { currencyResourceMeta, companyResourceMeta } from '~/modules/base/meta.ts'
import type { Actor } from '../authz/actor.ts'
import { decodeResourceDocument } from '@synie/shared'

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
  test('全部基线资源可 seal，报告 legacy 计数', () => {
    const registry = createRegistry()
    registerAllResources(registry)
    expect(registry.isSealed()).toBe(false)
    const report = registry.seal()
    expect(registry.isSealed()).toBe(true)
    expect(report.total).toBe(97)
    expect(report.legacy).toBe(97)
    expect(report.typed).toBe(0)
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

  test('v2 commands 使用语义 key（reconcile/recalc），不含 transport', () => {
    const registry = createSealedResourceRegistry()
    const recon = registry.buildDocument('accBankTransactions', superAdmin)
    expect(recon.catalog!.commands.some((c) => c.key === 'reconcile')).toBe(true)
    expect(recon.catalog!.commands.every((c) => !('http' in c))).toBe(true)

    const days = registry.buildDocument('hrAttendanceDays', superAdmin)
    expect(days.catalog!.commands.some((c) => c.key === 'recalc')).toBe(true)

    const storage = registry.buildDocument('sysStorages', superAdmin)
    expect(storage.catalog!.commands.some((c) => c.key === 'setDefault')).toBe(true)
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
})
