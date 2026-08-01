import { createRowCommandAdapter } from './catalog/commands'
import type { ResourceClient } from './types'

const unavailable = async (): Promise<never> => {
  throw new Error('打印模板能力尚未由 Convex 应用壳装配')
}

export const printTemplateClient: ResourceClient = {
  id: 'convex:sysPrintTemplates',
  query: unavailable,
  get: unavailable,
  create: unavailable,
  update: unavailable,
  delete: unavailable,
}

export const printTemplateCommandAdapter = createRowCommandAdapter({
  setDefault: unavailable,
  unsetDefault: unavailable,
})
