import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import { resourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

export const printTemplateClient: ResourceClient = {
  id: 'rest:sysPrintTemplates',
  async query(input) {
    const result = await apiData(
      api.system.printing.templates.query.$post({
        json: resourceListBody(input),
      }),
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
    await apiData(
      api.system.printing.templates[':id'].$delete({ param: { id } }),
    )
  },
}

export function listPrintResources() {
  return apiData(api.printing.resources.$get())
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

export const printTemplateCommandAdapter = createRowCommandAdapter({
  setDefault: setDefaultPrintTemplate,
  unsetDefault: unsetDefaultPrintTemplate,
})
