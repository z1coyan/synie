import type { ResourceQueryProfileDocument } from '@synie/shared'

export type SealedQueryProfile = ResourceQueryProfileDocument & {
  source:
    | { kind: 'index'; name: string; fields: readonly string[] }
    | {
        kind: 'search'
        name: string
        searchField: string
        filterFields: readonly string[]
      }
}

export const pilotQueryProfiles = {
  basCurrencies: [
    {
      key: 'default',
      kind: 'index',
      equalityFields: [],
      fixedSort: 'ascending',
      source: { kind: 'index', name: 'by_iso_code_key', fields: ['isoCodeKey'] },
    },
    {
      key: 'lookup',
      kind: 'index',
      equalityFields: ['active'],
      fixedSort: 'ascending',
      source: {
        kind: 'index',
        name: 'by_active_iso_code_key',
        fields: ['active', 'isoCodeKey'],
      },
    },
    {
      key: 'search',
      kind: 'search',
      equalityFields: ['active'],
      fixedSort: 'ascending',
      acceptsSearch: true,
      source: {
        kind: 'search',
        name: 'search_text',
        searchField: 'searchText',
        filterFields: ['active'],
      },
    },
  ],
  basUnits: [
    {
      key: 'default',
      kind: 'index',
      equalityFields: [],
      fixedSort: 'ascending',
      source: { kind: 'index', name: 'by_name_key', fields: ['nameKey'] },
    },
    {
      key: 'lookup',
      kind: 'index',
      equalityFields: ['unitType'],
      fixedSort: 'ascending',
      source: {
        kind: 'index',
        name: 'by_type_name_key',
        fields: ['unitType', 'nameKey'],
      },
    },
    {
      key: 'search',
      kind: 'search',
      equalityFields: [],
      fixedSort: 'ascending',
      acceptsSearch: true,
      source: {
        kind: 'search',
        name: 'search_text',
        searchField: 'searchText',
        filterFields: ['unitType', 'isBase'],
      },
    },
  ],
  invWarehouses: [
    {
      key: 'default',
      kind: 'index',
      equalityFields: ['companyId'],
      fixedSort: 'ascending',
      companyScopeField: 'companyId',
      source: {
        kind: 'index',
        name: 'by_company_name_key',
        fields: ['companyId', 'nameKey'],
      },
    },
    {
      key: 'lookup',
      kind: 'index',
      equalityFields: ['companyId', 'active', 'isLeaf'],
      fixedSort: 'ascending',
      companyScopeField: 'companyId',
      source: {
        kind: 'index',
        name: 'by_company_active_is_leaf_name_key',
        fields: ['companyId', 'active', 'isLeaf', 'nameKey'],
      },
    },
    {
      key: 'treeChildren',
      kind: 'index',
      equalityFields: ['companyId', 'parentId'],
      fixedSort: 'ascending',
      companyScopeField: 'companyId',
      source: {
        kind: 'index',
        name: 'by_company_parent_name_key',
        fields: ['companyId', 'parentId', 'nameKey'],
      },
    },
    {
      key: 'search',
      kind: 'search',
      equalityFields: ['companyId'],
      fixedSort: 'ascending',
      acceptsSearch: true,
      companyScopeField: 'companyId',
      source: {
        kind: 'search',
        name: 'search_text',
        searchField: 'searchText',
        filterFields: ['companyId', 'parentId', 'active', 'isLeaf', 'isOutsourced', 'partyType', 'partyId'],
      },
    },
  ],
} as const satisfies Record<string, readonly SealedQueryProfile[]>

export function publicQueryProfiles(resource: keyof typeof pilotQueryProfiles): ResourceQueryProfileDocument[] {
  return pilotQueryProfiles[resource].map(({ source: _source, ...profile }) => ({ ...profile }))
}

export function sealQueryProfiles(resource: keyof typeof pilotQueryProfiles): void {
  const profiles: readonly SealedQueryProfile[] = pilotQueryProfiles[resource]
  if (profiles.length === 0) throw new Error(`${resource}: 至少需要一个 query profile`)
  const keys = new Set<string>()
  for (const profile of profiles) {
    if (keys.has(profile.key)) throw new Error(`${resource}: query profile key 重复: ${profile.key}`)
    keys.add(profile.key)
    if (profile.kind !== profile.source.kind) {
      throw new Error(`${resource}.${profile.key}: profile/source kind 不一致`)
    }
    if (profile.source.kind === 'index') {
      const prefix = profile.source.fields.slice(0, profile.equalityFields.length)
      if (prefix.join('\0') !== profile.equalityFields.join('\0')) {
        throw new Error(`${resource}.${profile.key}: equalityFields 不是 index 前缀`)
      }
    } else {
      const filterFields: readonly string[] = profile.source.filterFields
      for (const field of profile.equalityFields) {
        if (!filterFields.includes(field)) {
          throw new Error(`${resource}.${profile.key}: search filter 未声明: ${field}`)
        }
      }
    }
  }
}
