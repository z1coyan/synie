import { apiData, api } from '../api/client'
import { createRowCommandAdapter } from './catalog/commands'
import { restTransport } from './rest-transport'

export const printTemplateClient = restTransport(
  'sysPrintTemplates',
  api.system.printing.templates,
)

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
