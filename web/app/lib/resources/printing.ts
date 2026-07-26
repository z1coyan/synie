import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

function queryBody(input: ResourceQuery): components['schemas']['ListQuery'] {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as components['schemas']['FilterState'],
  }
}

export const printTemplateClient: ResourceClient = {
  id: 'rest:sysPrintTemplates',
  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'sysPrintTemplates' } },
        }),
      ),
    )
  },
  async query(input) {
    const result = await apiData(
      apiClient.POST('/system/printing/templates/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/system/printing/templates/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/system/printing/templates', {
        body: input as components['schemas']['PrintTemplateCreate'],
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/system/printing/templates/{id}', {
        params: { path: { id } },
        body: input as components['schemas']['PrintTemplateUpdate'],
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/system/printing/templates/{id}', { params: { path: { id } } }),
    )
  },
}

export function listPrintResources() {
  return apiData(apiClient.GET('/printing/resources'))
}

export function setDefaultPrintTemplate(id: string) {
  return apiData(
    apiClient.POST('/system/printing/templates/{id}/set-default', {
      params: { path: { id } },
    }),
  )
}

export function unsetDefaultPrintTemplate(id: string) {
  return apiData(
    apiClient.POST('/system/printing/templates/{id}/unset-default', {
      params: { path: { id } },
    }),
  )
}
