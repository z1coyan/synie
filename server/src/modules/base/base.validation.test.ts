import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/platform/http/errors.ts'
import { normalizeCreate, validateInput } from './account-service.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import { deriveWireSchemas } from '~/platform/standard/wire.ts'
import { allBaseResourceMetas, unitResourceMeta } from './meta.ts'

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

  test('计量单位派生 schema：trim/枚举/长度/未知键', () => {
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

    // 未知枚举值 / 超长 / 未知键 / 空必填
    expect(schemas.create.safeParse({ unitType: 'VOLUME', name: '升', symbol: 'L', ratio: '1' }).success).toBe(false)
    expect(
      schemas.create.safeParse({ unitType: 'AREA', name: 'x'.repeat(33), symbol: 'm2', ratio: '1' }).success,
    ).toBe(false)
    expect(
      schemas.create.safeParse({ unitType: 'AREA', name: '平米', symbol: 'm2', ratio: '1', bogus: 1 }).success,
    ).toBe(false)
    expect(schemas.create.safeParse({ unitType: 'AREA', name: '  ', symbol: 'm2', ratio: '1' }).success).toBe(false)
    // 非十进制 ratio 由 decimalStringSchema 拦截
    expect(schemas.create.safeParse({ unitType: 'AREA', name: '平米', symbol: 'm2', ratio: 'abc' }).success).toBe(false)
  })

  test('会计科目：方向/角色/汇总清 role', () => {
    const leaf = normalizeCreate({
      code: '1124',
      name: '未开票应收',
      direction: 'DEBIT',
      role: 'UNBILLED_RECEIVABLE',
      companyId: '00000000-0000-0000-0000-000000000001',
    })
    expect(leaf.role).toBe('unbilled_receivable')
    validateInput(leaf)

    const group = normalizeCreate({
      code: '1',
      name: '资产',
      direction: 'DEBIT',
      isGroup: true,
      role: 'RECEIVABLE',
      companyId: '00000000-0000-0000-0000-000000000001',
    })
    expect(group.role).toBeNull()
    expect(group.direction).toBe('debit')
    validateInput(group)

    expect(() =>
      validateInput({
        code: '',
        name: 'x',
        direction: 'debit',
        companyId: 'c',
        role: null,
      }),
    ).toThrow(ApiError)

    expect(() =>
      validateInput({
        code: '1',
        name: 'x',
        direction: 'sideways',
        companyId: 'c',
        role: null,
      }),
    ).toThrow(ApiError)

    expect(() =>
      validateInput({
        code: '1',
        name: 'x',
        direction: 'debit',
        companyId: 'c',
        role: 'NOT_A_ROLE',
      }),
    ).toThrow(ApiError)
  })
})
