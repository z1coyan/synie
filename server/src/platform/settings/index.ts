import type { Registry } from '../meta/registry.ts'
import { allSettingResourceMetas } from './meta.ts'

export { createSettingsService, type SettingsService } from './service.ts'
export { settingsRoutes } from './routes.ts'
export {
  salesResourceMeta,
  manufacturingResourceMeta,
  accountingResourceMeta,
  systemResourceMeta,
  allSettingResourceMetas,
} from './meta.ts'

export function registerSettingResources(registry: Registry): void {
  for (const meta of allSettingResourceMetas()) {
    registry.register(meta)
  }
}
