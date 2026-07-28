import type { Registry } from '../meta/registry.ts'
import { counterResourceMeta, ruleResourceMeta } from './meta.ts'

export { createNumberingService, type NumberingService } from './service.ts'
export { numberingRoutes } from './routes.ts'
export { loadCatalog } from './catalog.ts'
export { ruleResourceMeta, counterResourceMeta } from './meta.ts'

export function registerNumberingResources(registry: Registry): void {
  registry.register(ruleResourceMeta())
  registry.register(counterResourceMeta())
}
