/**
 * 应收应付打印上下文与权限目录：不碰库。
 */
import { describe, expect, test } from 'bun:test'
import { SALES_ROLE_PERMISSIONS } from '~/platform/setup/service.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { parseArApPrintContext } from './docbuilder.ts'
import { AR_AP_PERMISSION_PREFIX } from './meta.ts'

describe('parseArApPrintContext', () => {
  const companyId = '123e4567-e89b-42d3-a456-426614174000'
  const partyId = '123e4567-e89b-42d3-a456-426614174001'

  test('汇总：公司 + 截至日 + 视角即可', () => {
    const ctx = parseArApPrintContext({
      companyId,
      asOf: '2026-07-31',
      side: 'ar',
      search: '甲',
      partyTypes: ['CUSTOMER'],
      sortColumn: 'net',
      sortDirection: 'descending',
    })
    expect(ctx.companyId).toBe(companyId)
    expect(ctx.asOf).toBe('2026-07-31')
    expect(ctx.side).toBe('ar')
    expect(ctx.search).toBe('甲')
    expect(ctx.partyTypes).toEqual(['CUSTOMER'])
    expect(ctx.partyNil).toBe(false)
    expect(ctx.partyId).toBeNull()
  })

  test('明细：指定对手或未指定对手', () => {
    const named = parseArApPrintContext({
      companyId,
      asOf: '2026-07-31',
      side: 'ap',
      partyType: 'CUSTOMER',
      partyId,
    })
    expect(named.partyType).toBe('CUSTOMER')
    expect(named.partyId).toBe(partyId)
    expect(named.partyNil).toBe(false)

    const nil = parseArApPrintContext({
      companyId,
      asOf: '2026-07-31',
      side: 'ar',
      partyNil: true,
    })
    expect(nil.partyNil).toBe(true)
    expect(nil.partyId).toBeNull()
    expect(nil.partyType).toBeNull()
  })

  test('缺公司/截至日/视角 → validation', () => {
    expect(() => parseArApPrintContext({ asOf: '2026-07-31', side: 'ar' })).toThrow(ApiError)
    expect(() => parseArApPrintContext({ companyId, side: 'ar' })).toThrow(ApiError)
    expect(() => parseArApPrintContext({ companyId, asOf: '2026-07-31', side: 'xx' })).toThrow(
      ApiError,
    )
  })
})

describe('acc.ar_ap 权限目录', () => {
  const registry = createSealedResourceRegistry()
  const codes = new Set(registry.allPermissionCodes())
  const group = registry.permissionCatalog().find((g) => g.prefix === AR_AP_PERMISSION_PREFIX)
  const gl = registry.permissionCatalog().find((g) => g.prefix === 'acc.gl_entry')

  test('只声明 export/print，不进 read，也不挂到分录列表', () => {
    expect(group?.actions.slice().sort()).toEqual(['export', 'print'])
    expect(codes.has('acc.ar_ap:export')).toBe(true)
    expect(codes.has('acc.ar_ap:print')).toBe(true)
    expect(codes.has('acc.ar_ap:read')).toBe(false)
    expect(gl?.actions).toEqual(['read'])
    expect(codes.has('acc.gl_entry:export')).toBe(false)
    expect(codes.has('acc.gl_entry:print')).toBe(false)
  })

  test('sales 预置角色 fail-closed，不种子新码', () => {
    expect(SALES_ROLE_PERMISSIONS.some((code) => code.startsWith('acc.ar_ap:'))).toBe(false)
  })
})
