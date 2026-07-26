import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceClient } from './types'
import { gridMeta } from './meta'

type AccountCreate = components['schemas']['AccountCreate']
type AccountUpdate = components['schemas']['AccountUpdate']
type AccountTemplate = components['schemas']['AccountTemplateInitialize']['template']

export const accountClient: ResourceClient = {
  id: 'rest:basAccounts',

  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'basAccounts' } },
        }),
      ),
    )
  },

  async query(input) {
    const filter = {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    }
    const result = await apiData(
      apiClient.POST('/base/accounts/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: filter as components['schemas']['FilterState'],
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/base/accounts/{id}', { params: { path: { id } } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/base/accounts', { body: input as AccountCreate }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/base/accounts/{id}', {
        params: { path: { id } },
        body: input as AccountUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/base/accounts/{id}', { params: { path: { id } } }),
    )
  },
}

export async function initializeAccountTemplate(companyId: string, template: AccountTemplate) {
  return apiData(
    apiClient.POST('/base/accounts/init-template', {
      body: { companyId, template },
    }),
  )
}
