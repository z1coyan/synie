/**
 * Resource Catalog 工单 01 特征测试：锁定 Actor 投影与现有 Meta 行为，
 * 作为后续 expand/migrate 的等价基线（不改变产品语义）。
 */
import { describe, expect, test } from 'bun:test'
import type { Actor } from '../authz/actor.ts'
import { createSealedResourceRegistry } from './register-all.ts'
import { CURRENCY_RESOURCE_NAME } from '~/modules/base/meta.ts'

function actor(partial: Partial<Actor> & Pick<Actor, 'permissions'>): Actor {
  return {
    userId: 'u-char',
    username: 'char',
    name: null,
    superAdmin: false,
    allCompanies: true,
    companyIds: [],
    ...partial,
  }
}

const superAdmin: Actor = {
  userId: 'u-admin',
  username: 'admin',
  name: null,
  superAdmin: true,
  allCompanies: true,
  permissions: new Set(),
  companyIds: [],
}

describe('Resource Catalog 特征：统一注册与 Actor 投影', () => {
  const registry = createSealedResourceRegistry()

  test('生产与测试共用注册入口可装载全部资源', () => {
    const names = registry.list().map((r) => r.name).sort()
    expect(names.length).toBeGreaterThan(80)
    expect(names).toContain(CURRENCY_RESOURCE_NAME)
    expect(names).toContain('basCompanies')
    expect(names).toContain('sysStorages')
    expect(names).toContain('accBankReconciliations')
    expect(names).toContain('hrAttendanceDays')
    expect(names).toContain('mfgSettings')
  })

  test('superadmin 币种 Meta 透传 form 且含完整 capabilities', () => {
    const doc = registry.buildDocument(CURRENCY_RESOURCE_NAME, superAdmin)
    expect(doc.name).toBe(CURRENCY_RESOURCE_NAME)
    expect(doc.form).toBeDefined()
    expect(doc.form?.exclude).toEqual(
      expect.arrayContaining(['id', 'active', 'insertedAt', 'updatedAt']),
    )
    expect(doc.form?.fields?.isoCode).toMatchObject({
      required: true,
      edit: 'createOnly',
    })
    expect(doc.grid.capabilities).toEqual(
      expect.arrayContaining(['create', 'update', 'delete']),
    )
    expect(doc.grid.capabilities).not.toContain('read')
    const iso = doc.grid.columns.find((c) => c.name === 'isoCode')
    expect(iso?.label).toBe('ISO 编码')
    expect(iso?.sortable).toBe(true)
  })

  test('Actor capability 按 permissionAction 投影，不含无权动作', () => {
    const readOnly = actor({
      permissions: new Set(['base.currency:read']),
    })
    const doc = registry.buildDocument(CURRENCY_RESOURCE_NAME, readOnly)
    expect(doc.grid.capabilities).toEqual([])
    expect(doc.grid.extendedActions).toEqual([])

    const editor = actor({
      permissions: new Set(['base.currency:read', 'base.currency:update']),
    })
    const editDoc = registry.buildDocument(CURRENCY_RESOURCE_NAME, editor)
    expect(editDoc.grid.capabilities).toEqual(['update'])
  })

  test('普通外键：有目标读取权时保留 ref', () => {
    const withCurrency = actor({
      permissions: new Set(['base.company:read', 'base.currency:read']),
    })
    const doc = registry.buildDocument('basCompanies', withCurrency)
    const baseCurrency = doc.grid.columns.find((c) => c.name === 'baseCurrencyId')
    expect(baseCurrency?.type).toBe('fk')
    expect(baseCurrency?.ref).toMatchObject({
      resource: 'basCurrencies',
      relation: 'baseCurrency',
      labelField: 'name',
    })
  })

  test('普通外键：无目标读取权时降级为原始 ID 列', () => {
    const noCurrency = actor({
      permissions: new Set(['base.company:read']),
    })
    const doc = registry.buildDocument('basCompanies', noCurrency)
    const baseCurrency = doc.grid.columns.find((c) => c.name === 'baseCurrencyId')
    expect(baseCurrency?.type).toBe('string')
    expect(baseCurrency?.ref).toBeNull()
    expect(baseCurrency?.sortable).toBe(true)
    expect(baseCurrency?.filterable).toBe(false)
  })

  test('多态外键：仅保留 Actor 可读的 variants', () => {
    const onlyCompany = actor({
      permissions: new Set(['acc.gl_entry:read', 'base.company:read']),
    })
    const doc = registry.buildDocument('accGlEntries', onlyCompany)
    const party = doc.grid.columns.find((c) => c.name === 'partyId')
    expect(party?.type).toBe('fk')
    expect(party?.ref?.discriminator).toBe('partyType')
    expect(party?.ref?.variants?.map((v) => v.resource).sort()).toEqual(['basCompanies'])

    const noTarget = actor({
      permissions: new Set(['acc.gl_entry:read']),
    })
    const degraded = registry.buildDocument('accGlEntries', noTarget)
    const partyDegraded = degraded.grid.columns.find((c) => c.name === 'partyId')
    expect(partyDegraded?.type).toBe('string')
    expect(partyDegraded?.ref).toBeNull()
  })

  test('自定义 permissionAction：setDefault 贡献 update capability', () => {
    const updater = actor({
      permissions: new Set(['sys.storage:read', 'sys.storage:update']),
    })
    const doc = registry.buildDocument('sysStorages', updater)
    expect(doc.grid.capabilities).toContain('update')
    const setDefault = doc.grid.extendedActions.find((a) => a.key === 'setDefault')
    expect(setDefault).toMatchObject({
      key: 'setDefault',
      label: '设为默认',
      scope: 'row',
    })
    expect(setDefault?.http).toMatchObject({
      method: 'POST',
      path: '/api/v1/system/storages/{id}/set-default',
    })
  })

  test('自定义 permissionAction：banking reconcile 与 attendance recalc', () => {
    // v1：对账挂在流水上，action.key=export、permissionAction=reconcile；
    // export 属标准动作不进 extendedActions，但 capability 用 permissionAction。
    const recon = actor({
      permissions: new Set(['acc.bank_transaction:read', 'acc.bank_transaction:reconcile']),
    })
    const reconDoc = registry.buildDocument('accBankTransactions', recon)
    expect(reconDoc.grid.capabilities).toContain('reconcile')
    expect(reconDoc.grid.capabilities).not.toContain('export')
    const reconMeta = registry.get('accBankTransactions')!
    expect(
      reconMeta.actions.some((a) => a.key === 'export' && a.permissionAction === 'reconcile'),
    ).toBe(true)

    // v1：重算挂在考勤日，action.key=import、permissionAction=recalc
    const recalc = actor({
      permissions: new Set(['hr.attendance_day:read', 'hr.attendance_day:recalc']),
    })
    const recalcDoc = registry.buildDocument('hrAttendanceDays', recalc)
    expect(recalcDoc.grid.capabilities).toContain('recalc')
    expect(recalcDoc.grid.capabilities).not.toContain('import')
    const dayMeta = registry.get('hrAttendanceDays')!
    expect(
      dayMeta.actions.some((a) => a.key === 'import' && a.permissionAction === 'recalc'),
    ).toBe(true)
  })

  test('币种 Form 声明被完整透传到 Meta 响应（前端当前丢弃，基线保留）', () => {
    const doc = registry.buildDocument(CURRENCY_RESOURCE_NAME, superAdmin)
    expect(doc.form).toEqual({
      exclude: ['id', 'active', 'insertedAt', 'updatedAt'],
      fields: {
        name: { required: true, placeholder: '如 人民币' },
        isoCode: { required: true, edit: 'createOnly', placeholder: '三位大写字母,如 CNY' },
        symbol: { placeholder: '如 ¥' },
      },
    })
  })
})
