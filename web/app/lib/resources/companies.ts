import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type CompanyCreate = components['schemas']['CompanyCreate']
type CompanyUpdate = components['schemas']['CompanyUpdate']

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('公司 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const companyClient: ResourceClient = {
  id: 'rest:basCompanies',

  async meta() {
    return gridMeta(await apiData(apiClient.GET('/meta/resources/{name}', {
      params: { path: { name: 'basCompanies' } },
    })))
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData(apiClient.POST('/base/companies/query', {
      body: {
        limit: input.limit,
        offset: input.offset,
        search: input.search || undefined,
        sort: input.sort ?? undefined,
        filter: input.filter as components['schemas']['FilterState'],
      },
    }))
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return await apiData(apiClient.GET('/base/companies/{id}', {
      params: { path: { id } },
    })) as Row
  },

  async create(input) {
    return await apiData(apiClient.POST('/base/companies', {
      body: input as CompanyCreate,
    })) as Row
  },

  async update(id, input) {
    return await apiData(apiClient.PATCH('/base/companies/{id}', {
      params: { path: { id } }, body: input as CompanyUpdate,
    })) as Row
  },

  async delete(id) {
    await apiData<void>(apiClient.DELETE('/base/companies/{id}', {
      params: { path: { id } },
    }))
  },
}
