import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = FilterState
type GLJournalCreate = Record<string, unknown>
type GLJournalUpdate = Record<string, unknown>
type GLJournalLineCreate = Record<string, unknown>
type GLJournalLineUpdate = Record<string, unknown>

export interface ARAPRoleAccount {
  id: string
  code: string
  name: string
  accountId?: string
  accountCode?: string
  accountName?: string
}
export interface ARAPBalances {
  [key: string]: string
}
export interface ARAPReportRow {
  partyType: string | null
  partyId: string | null
  partyLabel: string
  balances: ARAPBalances
  netReceivable: string
  netPayable: string
}
export interface ARAPReport {
  asOf: string
  roleAccounts: Record<string, ARAPRoleAccount[]>
  rows: ARAPReportRow[]
}

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
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
        param: { name: resource }}),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.accounting['gl-entries'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.accounting['gl-entries'][':id'].$get({ param: { id } }),
    )) as Row
  },

  create: readOnly('总账分录'),
  update: readOnly('总账分录'),
  delete: readOnly('总账分录'),
}

export async function auditGlJournal(id: string, postingDate?: string) {
  return apiData(
    api.accounting['gl-journals'][':id'].audit.$post({
      param: { id },
      json: postingDate ? { postingDate } : {} }),
  )
}

export async function cancelGlJournal(id: string) {
  return apiData(
    api.accounting['gl-journals'][':id'].cancel.$post({
      param: { id }}),
  )
}

export const glJournalClient: ResourceClient = {
  id: 'rest:accGlJournals',

  async meta() {
    return meta('accGlJournals')
  },

  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.accounting['gl-journals'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.accounting['gl-journals'][':id'].$get({ param: { id } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.accounting['gl-journals'].$post({ json: input as never }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.accounting['gl-journals'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.accounting['gl-journals'][':id'].$delete({ param: { id } }),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.accounting['gl-journal-lines'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.accounting['gl-journal-lines'][':id'].$get({ param: { id } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.accounting['gl-journal-lines'].$post({
        json: decimalInput(input) as never}),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.accounting['gl-journal-lines'][':id'].$patch({
        param: { id },
        json: decimalInput(input) as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.accounting['gl-journal-lines'][':id'].$delete({
        param: { id }}),
    )
  },
}

export function fetchARAPReport(companyId: string, asOf: string): Promise<ARAPReport> {
  return apiData(
    api.accounting['ar-ap-report'].$get({
      query: { companyId, asOf }}),
  )
}
