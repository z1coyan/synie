/**
 * Resource Catalog 特征测试：锁定 Actor 投影与 Catalog 行为。
 * contract 后 Meta 响应仅为 ResourceDocument v2。
 */
import { describe, expect, test } from 'bun:test'
import type { Actor } from '../authz/actor.ts'
import { createSealedResourceRegistry } from './register-all.ts'
import { CURRENCY_RESOURCE_NAME } from '~/modules/base/meta.ts'
import { testActor, type TestActorInput } from '~/platform/authz/testing.ts'

function actor(partial: TestActorInput): Actor {
  return testActor({
    userId: 'u-char',
    username: 'char',
    name: null,
    superAdmin: false,
    allCompanies: true,
    companyIds: [],
    ...partial,
  })
}

const superAdmin: Actor = testActor({
  userId: 'u-admin',
  username: 'admin',
  name: null,
  superAdmin: true,
  allCompanies: true,
  permissions: new Set(),
  companyIds: [],
})

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

  test('superadmin 币种 Meta 为 ResourceDocument v2 且含完整 capabilities', () => {
    const doc = registry.buildDocument(CURRENCY_RESOURCE_NAME, superAdmin)
    expect(doc.schemaVersion).toBe(2)
    expect(doc.name).toBe(CURRENCY_RESOURCE_NAME)
    expect(doc.label).toBe('货币')
    expect(doc.form.kind).toBe('basic')
    expect(doc.capabilities).toEqual(expect.arrayContaining(['create', 'update', 'delete']))
    expect(doc.capabilities).not.toContain('read')
    const iso = doc.fields.find((f) => f.name === 'isoCode')
    expect(iso?.label).toBe('ISO 编码')
    expect(iso?.sortable).toBe(true)
    if (iso && iso.kind === 'scalar') {
      expect(iso.input.create).toBe('required')
      expect(iso.input.update).toBe('forbidden')
    }
  })

  test('Actor capability 按 permissionAction 投影，不含无权动作', () => {
    const readOnly = actor(testActor({
      permissions: new Set(['base.currency:read']),
    }))
    const doc = registry.buildDocument(CURRENCY_RESOURCE_NAME, readOnly)
    expect(doc.capabilities).toEqual([])
    expect(doc.commands).toEqual([])

    const editor = actor(testActor({
      permissions: new Set(['base.currency:read', 'base.currency:update']),
    }))
    const editDoc = registry.buildDocument(CURRENCY_RESOURCE_NAME, editor)
    expect(editDoc.capabilities).toEqual(['update'])
  })

  test('普通外键：有目标读取权时保留 reference', () => {
    const withCurrency = actor(testActor({
      permissions: new Set(['base.company:read', 'base.currency:read']),
    }))
    const doc = registry.buildDocument('basCompanies', withCurrency)
    const baseCurrency = doc.fields.find((f) => f.name === 'baseCurrencyId')
    expect(baseCurrency?.kind).toBe('reference')
    if (baseCurrency?.kind === 'reference') {
      expect(baseCurrency.targetResource).toBe('basCurrencies')
      expect(baseCurrency.targetUnavailable).toBeFalsy()
    }
  })

  test('普通外键：无目标读取权时标记 targetUnavailable', () => {
    const noCurrency = actor(testActor({
      permissions: new Set(['base.company:read']),
    }))
    const doc = registry.buildDocument('basCompanies', noCurrency)
    const baseCurrency = doc.fields.find((f) => f.name === 'baseCurrencyId')
    expect(baseCurrency?.kind).toBe('reference')
    if (baseCurrency?.kind === 'reference') {
      expect(baseCurrency.targetUnavailable).toBe(true)
    }
  })

  test('多态外键：仅保留 Actor 可读的 variants', () => {
    const onlyCompany = actor(testActor({
      permissions: new Set(['acc.gl_entry:read', 'base.company:read']),
    }))
    const doc = registry.buildDocument('accGlEntries', onlyCompany)
    const party = doc.fields.find((f) => f.name === 'partyId')
    expect(party?.kind).toBe('polymorphicReference')
    if (party?.kind === 'polymorphicReference') {
      expect(party.variants.map((v) => v.resource).sort()).toEqual(['basCompanies'])
      expect(party.targetUnavailable).toBeFalsy()
    }

    const noTarget = actor(testActor({
      permissions: new Set(['acc.gl_entry:read']),
    }))
    const degraded = registry.buildDocument('accGlEntries', noTarget)
    const partyDegraded = degraded.fields.find((f) => f.name === 'partyId')
    expect(partyDegraded?.kind).toBe('polymorphicReference')
    if (partyDegraded?.kind === 'polymorphicReference') {
      expect(partyDegraded.targetUnavailable).toBe(true)
      expect(partyDegraded.variants).toEqual([])
    }
  })

  test('自定义 permissionAction：setDefault 贡献 update capability 与 command', () => {
    const updater = actor(testActor({
      permissions: new Set(['sys.storage:read', 'sys.storage:update']),
    }))
    const doc = registry.buildDocument('sysStorages', updater)
    expect(doc.capabilities).toContain('update')
    const setDefault = doc.commands.find((a) => a.key === 'setDefault')
    expect(setDefault).toMatchObject({
      key: 'setDefault',
      label: '设为默认',
      target: 'row',
      requiredCapability: 'update',
    })
    // v1 http transport 不得出现在 ResourceDocument
    expect(setDefault && !('http' in setDefault)).toBe(true)
  })

  test('语义 command：banking reconcile 与 attendance recalc', () => {
    const recon = actor(testActor({
      permissions: new Set(['acc.bank_transaction:read', 'acc.bank_transaction:reconcile']),
    }))
    const reconDoc = registry.buildDocument('accBankTransactions', recon)
    expect(reconDoc.capabilities).toContain('reconcile')
    expect(reconDoc.capabilities).not.toContain('export')
    expect(reconDoc.commands.some((c) => c.key === 'reconcile')).toBe(true)
    const reconMeta = registry.get('accBankTransactions')!
    expect(
      reconMeta.actions.some((a) => a.key === 'export' && a.permissionAction === 'reconcile'),
    ).toBe(true)

    const recalc = actor(testActor({
      permissions: new Set(['hr.attendance_day:read', 'hr.attendance_day:recalc']),
    }))
    const recalcDoc = registry.buildDocument('hrAttendanceDays', recalc)
    expect(recalcDoc.capabilities).toContain('recalc')
    expect(recalcDoc.capabilities).not.toContain('import')
    expect(recalcDoc.commands.some((c) => c.key === 'recalc')).toBe(true)
    const dayMeta = registry.get('hrAttendanceDays')!
    expect(
      dayMeta.actions.some((a) => a.key === 'import' && a.permissionAction === 'recalc'),
    ).toBe(true)
  })

  test('币种 form.kind=basic 且布局含字段', () => {
    const doc = registry.buildDocument(CURRENCY_RESOURCE_NAME, superAdmin)
    expect(doc.form.kind).toBe('basic')
    if (doc.form.kind === 'basic') {
      const placed = doc.form.layout.fields?.map((p) => p.field) ?? []
      expect(placed).toEqual(expect.arrayContaining(['name', 'isoCode', 'symbol']))
    }
  })
})
