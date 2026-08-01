import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ResourceDocument } from '@synie/shared'
import type { Actor } from '../server/src/platform/authz/actor'
import { createSealedResourceRegistry } from '../server/src/platform/meta/register-all'
import { domainEqualityFields, domainSortFields } from '../convex/domains/shared/queryProfiles'

const registry = createSealedResourceRegistry()
const actor: Actor = {
  userId: 'catalog-generator',
  username: 'catalog-generator',
  name: null,
  superAdmin: true,
  allCompanies: true,
  permissions: new Set(),
  companyIds: [],
}

const result: Record<string, ResourceDocument> = {}
for (const resource of registry.list()) {
  const document = registry.buildDocument(resource.name, actor)
  const companyScoped = document.fields.some((field) => field.name === 'companyId')
  const profiles: NonNullable<ResourceDocument['queryProfiles']> = [
    {
      key: 'default',
      kind: 'index',
      equalityFields: companyScoped ? ['companyId'] : [],
      fixedSort: 'ascending',
      ...(companyScoped ? { companyScopeField: 'companyId' } : {}),
    },
  ]
  if (document.lookup.searchFields.length > 0) {
    profiles.push({
      key: 'search',
      kind: 'search',
      equalityFields: companyScoped ? ['companyId'] : [],
      fixedSort: 'ascending',
      acceptsSearch: true,
      ...(companyScoped ? { companyScopeField: 'companyId' } : {}),
    })
  }
  for (const field of domainSortFields(resource.name)) {
    for (const fixedSort of ['ascending', 'descending'] as const) {
      profiles.push({
        key: `sort:${field}:${fixedSort}`,
        kind: 'index',
        equalityFields: companyScoped ? ['companyId'] : [],
        fixedSort,
        ...(companyScoped ? { companyScopeField: 'companyId' } : {}),
      })
    }
  }
  for (const field of domainEqualityFields(resource.name)) {
    profiles.push({
      key: `equality:${field}`,
      kind: 'index',
      equalityFields: [...(companyScoped ? ['companyId'] : []), field],
      fixedSort: 'ascending',
      ...(companyScoped ? { companyScopeField: 'companyId' } : {}),
    })
  }
  result[resource.name] = { ...document, queryProfiles: profiles }
}

const target = resolve(import.meta.dir, '../convex/catalog/generatedDocuments.json')
writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 })
chmodSync(target, 0o644)
console.log(`generated ${Object.keys(result).length} Convex ResourceDocument snapshots`)
