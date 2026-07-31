import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/platform/http/errors.ts'
import { normalizeCreate, validateInput } from './account-service.ts'
import { normalize } from './unit-service.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import { allBaseResourceMetas } from './meta.ts'

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

  test('计量单位 normalize：四类/ratio>0/基准=1', () => {
    const ok = normalize(' weight ', ' 千克 ', ' kg ', '0.001', false)
    expect(ok.unitType).toBe('weight')
    expect(ok.name).toBe('千克')
    expect(ok.symbol).toBe('kg')
    expect(ok.ratio).toBe('0.001')

    expect(() => normalize('volume', '升', 'L', '1', false)).toThrow(ApiError)
    expect(() => normalize('quantity', '件', 'pcs', '0', false)).toThrow(ApiError)
    expect(() => normalize('length', '米', 'm', '1000', true)).toThrow(ApiError)
    expect(() => normalize('area', 'x'.repeat(33), 'm2', '1', false)).toThrow(ApiError)
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
