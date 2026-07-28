import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceClient } from './types'
import { gridMeta } from './meta'

type AccountCreate = Record<string, unknown>
type AccountUpdate = Record<string, unknown>
type AccountTemplate = "CAS" | "SMALL" | "INTL"

export const accountClient: ResourceClient = {
  id: 'rest:basAccounts',

  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'basAccounts' }}),
      ),
    )
  },

  async query(input) {
    const filter = {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    }
    const result = await apiData<{ count: number; results: Row[] }>(
      api.base.accounts.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: filter as FilterState} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.base.accounts[':id'].$get({ param: { id } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.base.accounts.$post({ json: input as never }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.base.accounts[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.base.accounts[':id'].$delete({ param: { id } }),
    )
  },
}

export async function initializeAccountTemplate(companyId: string, template: AccountTemplate) {
  return apiData<{ createdCount: number }>(
    api.base.accounts['init-template'].$post({
      json: { companyId, template },
    }),
  )
}
