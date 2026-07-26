import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = components['schemas']['FilterState']
type GLJournalCreate = components['schemas']['GLJournalCreate']
type GLJournalUpdate = components['schemas']['GLJournalUpdate']
type GLJournalLineCreate = components['schemas']['GLJournalLineCreate']
type GLJournalLineUpdate = components['schemas']['GLJournalLineUpdate']

export type ARAPReport = components['schemas']['ARAPReport']
export type ARAPReportRow = components['schemas']['ARAPReportRow']
export type ARAPRoleAccount = components['schemas']['ARAPRoleAccount']

function queryBody(input: ResourceQuery) {
  const filter = {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: filter as FilterDocument,
  }
}

async function meta(resource: 'accGlEntries' | 'accGlJournals' | 'accGlJournalLines') {
  return gridMeta(
    await apiData(
      apiClient.GET('/meta/resources/{name}', {
        params: { path: { name: resource } },
      }),
    ),
  )
}

function decimalInput(input: Record<string, unknown>): Record<string, unknown> {
  const body = { ...input }
  for (const field of ['debit', 'credit'] as const) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    body[field] = value == null || value === '' ? '0' : String(value)
  }
  return body
}

const readOnly = (label: string) => async () => {
  throw new Error(`${label}是只读财务事实,不支持写入`)
}

export const glEntryClient: ResourceClient = {
  id: 'rest:accGlEntries',

  async meta() {
    return meta('accGlEntries')
  },

  async query(input) {
    const result = await apiData(
      apiClient.POST('/accounting/gl-entries/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/accounting/gl-entries/{id}', { params: { path: { id } } }),
    )) as Row
  },

  create: readOnly('总账分录'),
  update: readOnly('总账分录'),
  delete: readOnly('总账分录'),
}

export async function auditGlJournal(id: string, postingDate?: string) {
  return apiData(
    apiClient.POST('/accounting/gl-journals/{id}/audit', {
      params: { path: { id } },
      body: postingDate ? { postingDate } : {},
    }),
  )
}

export async function cancelGlJournal(id: string) {
  return apiData(
    apiClient.POST('/accounting/gl-journals/{id}/cancel', {
      params: { path: { id } },
    }),
  )
}

export const glJournalClient: ResourceClient = {
  id: 'rest:accGlJournals',

  async meta() {
    return meta('accGlJournals')
  },

  async query(input) {
    const result = await apiData(
      apiClient.POST('/accounting/gl-journals/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/accounting/gl-journals/{id}', { params: { path: { id } } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/accounting/gl-journals', { body: input as GLJournalCreate }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/accounting/gl-journals/{id}', {
        params: { path: { id } },
        body: input as GLJournalUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/accounting/gl-journals/{id}', { params: { path: { id } } }),
    )
  },

  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditGlJournal(id)
      else if (key === 'cancel') await cancelGlJournal(id)
      else throw new Error(`会计凭证 REST Client 未实现动作 ${key}`)
    }
  },
}

export const glJournalLineClient: ResourceClient = {
  id: 'rest:accGlJournalLines',

  async meta() {
    return meta('accGlJournalLines')
  },

  async query(input) {
    const result = await apiData(
      apiClient.POST('/accounting/gl-journal-lines/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/accounting/gl-journal-lines/{id}', { params: { path: { id } } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/accounting/gl-journal-lines', {
        body: decimalInput(input) as GLJournalLineCreate,
      }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/accounting/gl-journal-lines/{id}', {
        params: { path: { id } },
        body: decimalInput(input) as GLJournalLineUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/accounting/gl-journal-lines/{id}', {
        params: { path: { id } },
      }),
    )
  },
}

export function fetchARAPReport(companyId: string, asOf: string): Promise<ARAPReport> {
  return apiData(
    apiClient.GET('/accounting/ar-ap-report', {
      params: { query: { companyId, asOf } },
    }),
  )
}
