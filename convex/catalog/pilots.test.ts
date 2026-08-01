import { describe, expect, test } from 'bun:test'
import type { Actor } from '../lib/actor'
import { pilotResourceDocuments, projectPilotResource, sealPilotCatalog } from './pilots'

const actor = (permissions: string[]): Actor => ({
  userId: 'actor' as Actor['userId'], username: 'actor', name: null,
  superAdmin: false, allCompanies: false, companyIds: [], permissions: new Set(permissions),
})

describe('Convex pilot Resource Catalog', () => {
  test('seals all three documents and their query profiles', () => {
    expect(() => sealPilotCatalog()).not.toThrow()
    expect(Object.keys(pilotResourceDocuments).sort()).toEqual(['basCurrencies', 'basUnits', 'invWarehouses'])
    for (const document of Object.values(pilotResourceDocuments)) expect(document.queryProfiles?.length).toBeGreaterThanOrEqual(3)
  })

  test('Actor projection only returns authorized capabilities', () => {
    expect(projectPilotResource('basCurrencies', actor(['base.currency:update'])).capabilities).toEqual(['update'])
    expect(projectPilotResource('basCurrencies', actor([])).capabilities).toEqual([])
    expect(projectPilotResource('invWarehouses', actor(['inv.warehouse:create'])).commands.map((command) => command.key)).toEqual(['seedDefaults'])
    expect(projectPilotResource('invWarehouses', actor([])).commands).toEqual([])
  })

  test('unknown references and undeclared command capabilities fail closed', () => {
    const currency = structuredClone(pilotResourceDocuments.basCurrencies)
    currency.fields.push({
      name: 'broken', label: 'broken', kind: 'reference', targetResource: 'unknown',
      visibility: 'readable', input: { create: 'optional', update: 'allowed' }, filterable: false, sortable: false,
    })
    expect(() => sealPilotCatalog({ ...pilotResourceDocuments, basCurrencies: currency })).toThrow(/未知引用/)

    const unit = structuredClone(pilotResourceDocuments.basUnits)
    unit.commands.push({ key: 'oops', label: 'oops', target: 'row', requiredCapability: 'approve' })
    expect(() => sealPilotCatalog({ ...pilotResourceDocuments, basUnits: unit })).toThrow(/capability 未声明/)
  })

  test('pilot field labels/forms/permissions match the sealed legacy fixtures', () => {
    expect(pilotResourceDocuments.basCurrencies).toMatchObject({
      label: '货币', permissionPrefix: 'base.currency', form: { kind: 'basic' },
    })
    expect(pilotResourceDocuments.basUnits).toMatchObject({
      label: '单位', permissionPrefix: 'base.unit', form: { kind: 'basic' },
    })
    expect(pilotResourceDocuments.invWarehouses).toMatchObject({
      label: '仓库', permissionPrefix: 'inv.warehouse', form: { kind: 'basic' },
    })
    expect(Object.fromEntries(Object.entries(pilotResourceDocuments).map(([key, doc]) => [key, doc.fields.length]))).toEqual({
      basCurrencies: 7, basUnits: 8, invWarehouses: 14,
    })
  })
})
