import { describe, expect, test } from 'bun:test'
import { createRegistry } from '~/platform/meta/registry.ts'
import { allInventoryResourceMetas } from './meta.ts'
import { wireDecimal } from './helpers.ts'
import { decimal } from '@synie/shared'

describe('inventory meta 注册', () => {
  test('11 个资源可注册且权限前缀标签一致', () => {
    const registry = createRegistry()
    for (const meta of allInventoryResourceMetas()) {
      registry.register(meta)
    }
    const catalog = registry.permissionCatalog()
    const prefixes = catalog.map((g) => g.prefix)
    expect(prefixes).toContain('inv.material_category')
    expect(prefixes).toContain('inv.material')
    expect(prefixes).toContain('inv.warehouse')
    expect(prefixes).toContain('inv.stock_entry')
    expect(prefixes).toContain('inv.stock_doc')
    expect(prefixes).toContain('inv.stock_transfer')
    expect(prefixes).toContain('inv.stock_count')
    // 子资源共享前缀，不重复进目录
    const stockDoc = catalog.find((g) => g.prefix === 'inv.stock_doc')!
    expect(stockDoc.actions).toContain('audit')
    expect(stockDoc.actions).toContain('void')
    const transfer = catalog.find((g) => g.prefix === 'inv.stock_transfer')!
    expect(transfer.actions).toContain('ship')
    expect(transfer.actions).toContain('receive')
  })

  test('superadmin grid 含扩展动作', () => {
    const registry = createRegistry()
    for (const meta of allInventoryResourceMetas()) {
      registry.register(meta)
    }
    const actor = {
      userId: 'u',
      username: 'admin',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set<string>(),
      companyIds: [],
    }
    const doc = registry.buildDocument('invStockDocs', actor)
    expect(doc.capabilities).toContain('audit')
    expect(doc.capabilities).toContain('void')
    expect(doc.commands.some((a) => a.key === 'audit')).toBe(true)
  })
})

describe('inventory helpers', () => {
  test('wireDecimal 去掉尾零', () => {
    expect(wireDecimal(decimal('10'))).toBe('10')
    expect(wireDecimal(decimal('4.0'))).toBe('4')
    expect(wireDecimal(decimal('2.50'))).toBe('2.5')
  })
})
