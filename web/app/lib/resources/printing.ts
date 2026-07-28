import type { ListQuery } from '@synie/shared'
import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

function queryBody(input: ResourceQuery): ListQuery {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as FilterState,
  }
}

export const printTemplateClient: ResourceClient = {
  id: 'rest:sysPrintTemplates',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'sysPrintTemplates' }}),
      ),
    )
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.system.printing.templates.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.system.printing.templates[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.system.printing.templates.$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.system.printing.templates[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.system.printing.templates[':id'].$delete({ param: { id } }),
    )
  },
}

export function listPrintResources() {
  return apiData<{ resources: string[] }>(api.printing.resources.$get())
}

export function setDefaultPrintTemplate(id: string) {
  return apiData(
    api.system.printing.templates[':id']['set-default'].$post({
      param: { id }}),
  )
}

export function unsetDefaultPrintTemplate(id: string) {
  return apiData(
    api.system.printing.templates[':id']['unset-default'].$post({
      param: { id }}),
  )
}
