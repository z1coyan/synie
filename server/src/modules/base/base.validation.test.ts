import { describe, expect, test } from 'bun:test'
import { applyGroupRoleRule } from './account-service.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import { deriveWireSchemas } from '~/platform/standard/wire.ts'
import {
  accountResourceMeta,
  allBaseResourceMetas,
  companyResourceMeta,
  unitResourceMeta,
} from './meta.ts'

describe('base 校验与 Meta', () => {
  test('Meta 四资源可注册', () => {
    const registry = createRegistry()
    for (const meta of allBaseResourceMetas()) {
      registry.register(meta)
    }
    expect(registry.get('basCurrencies')?.permissionPrefix).toBe('base.currency')
    expect(registry.get('basCompanies')?.permissionPrefix).toBe('base.company')
    expect(registry.get('basUnits')?.permissionPrefix).toBe('base.unit')
    expect(registry.get('basAccounts')?.permissionPrefix).toBe('base.account')
  })

  // 未知键拒绝与 createOnly 不进 update 由 standard-contract 的单位/科目描述符继承；
  // 本文件只留字段级的 trim / 枚举 / 长度 / 十进制这些不在合同里的裁量。
  test('计量单位派生 schema：trim/枚举/长度', () => {
    const schemas = deriveWireSchemas(unitResourceMeta(), new Set())

    const ok = schemas.create.parse({
      unitType: 'WEIGHT',
      name: ' 千克 ',
      symbol: ' kg ',
      ratio: '0.001',
    }) as Record<string, unknown>
    expect(ok.name).toBe('千克')
    expect(ok.symbol).toBe('kg')
    expect(ok.ratio).toBe('0.001')

    // 未知枚举值 / 超长 / 空必填
    expect(schemas.create.safeParse({ unitType: 'VOLUME', name: '升', symbol: 'L', ratio: '1' }).success).toBe(false)
    expect(
      schemas.create.safeParse({ unitType: 'AREA', name: 'x'.repeat(33), symbol: 'm2', ratio: '1' }).success,
    ).toBe(false)
    expect(schemas.create.safeParse({ unitType: 'AREA', name: '  ', symbol: 'm2', ratio: '1' }).success).toBe(false)
    // 非十进制 ratio 由 decimalStringSchema 拦截
    expect(schemas.create.safeParse({ unitType: 'AREA', name: '平米', symbol: 'm2', ratio: 'abc' }).success).toBe(false)
  })

  test('会计科目派生 schema：方向/角色枚举、编码与名称长度', () => {
    const schemas = deriveWireSchemas(accountResourceMeta(), new Set())
    const companyId = '00000000-0000-0000-0000-000000000001'

    const ok = schemas.create.parse({
      code: ' 1124 ',
      name: ' 未开票应收 ',
      direction: 'DEBIT',
      role: 'UNBILLED_RECEIVABLE',
      companyId,
    }) as Record<string, unknown>
    expect(ok.code).toBe('1124')
    expect(ok.name).toBe('未开票应收')
    // wire 恒大写；库内小写由 toDbValue 落库时转换
    expect(ok.role).toBe('UNBILLED_RECEIVABLE')
    // 角色可空（清空）
    expect(schemas.create.safeParse({ code: '1', name: '资产', direction: 'DEBIT', role: null, companyId }).success).toBe(true)

    const bad = [
      { code: '', name: 'x', direction: 'DEBIT', companyId },
      { code: 'x'.repeat(33), name: 'x', direction: 'DEBIT', companyId },
      { code: '1', name: 'x'.repeat(129), direction: 'DEBIT', companyId },
      { code: '1', name: 'x', direction: 'sideways', companyId },
      { code: '1', name: 'x', direction: 'debit', companyId },
      { code: '1', name: 'x', direction: 'DEBIT', role: 'NOT_A_ROLE', companyId },
      { code: '1', name: 'x', direction: 'DEBIT' },
    ]
    for (const input of bad) {
      expect(schemas.create.safeParse(input).success).toBe(false)
    }

    // 上级可空：present-key 下 parentId 显式 null 进 update
    expect(schemas.update.safeParse({ name: '改名', parentId: null }).success).toBe(true)
  })

  test('会计科目：汇总科目清 role（领域钩子）', () => {
    const group: Record<string, unknown> = { isGroup: true, role: 'RECEIVABLE' }
    applyGroupRoleRule(group)
    expect(group.role).toBeNull()

    const leaf: Record<string, unknown> = { isGroup: false, role: 'RECEIVABLE' }
    applyGroupRoleRule(leaf)
    expect(leaf.role).toBe('RECEIVABLE')
  })

  test('公司派生 schema：名称/简称长度、上级可空、编号 createOnly', () => {
    const schemas = deriveWireSchemas(companyResourceMeta(), new Set())
    const currencyId = '00000000-0000-0000-0000-000000000002'

    const ok = schemas.create.parse({
      code: 'SH',
      name: ' 上海总部 ',
      shortName: ' 上海 ',
      parentId: null,
      baseCurrencyId: currencyId,
    }) as Record<string, unknown>
    expect(ok.name).toBe('上海总部')
    expect(ok.shortName).toBe('上海')

    const bad = [
      { code: 'SH', name: 'x'.repeat(129), shortName: '上海', baseCurrencyId: currencyId },
      { code: 'SH', name: '上海总部', shortName: 'x'.repeat(33), baseCurrencyId: currencyId },
      { code: 'SH', name: '  ', shortName: '上海', baseCurrencyId: currencyId },
      { code: 'SH', name: '上海总部', shortName: '上海' },
      { code: 'SH', name: '上海总部', shortName: '上海', baseCurrencyId: currencyId, bogus: 1 },
    ]
    for (const input of bad) {
      expect(schemas.create.safeParse(input).success).toBe(false)
    }

    expect(schemas.update.safeParse({ code: 'BJ' }).success).toBe(false)
    expect(schemas.update.safeParse({ name: '改名', parentId: null }).success).toBe(true)

    // present-key 语义（取代路由的 parentIdPresent 布尔）：缺省键不出现在解析结果里，
    // 显式 null 保留 → 服务侧「出现即写、null 清空、缺省不动」
    const cleared = schemas.update.parse({ parentId: null }) as Record<string, unknown>
    expect(Object.hasOwn(cleared, 'parentId')).toBe(true)
    expect(cleared.parentId).toBeNull()
    const renamed = schemas.update.parse({ name: '改名' }) as Record<string, unknown>
    expect(Object.hasOwn(renamed, 'parentId')).toBe(false)
  })
})
