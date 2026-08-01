import type { Registry } from '../meta/registry.ts'
import { allSettingResourceMetas } from './meta.ts'

export {
  createSettingsService,
  createSystemSettingService,
  type SettingsService,
  type SettingsDomainDeps,
  type SystemSettingService,
  type SalesSetting,
  type ManufacturingSetting,
  type AccountingSetting,
  type SystemSetting,
  type SalesUpdate,
  type ManufacturingUpdate,
  type AccountingUpdate,
  type SystemUpdate,
} from './service.ts'
export { settingsRoutes } from './routes.ts'
export { createSingleRowSetting, type SingleRowSettingConfig } from './single-row.ts'
export { systemResourceMeta, allSettingResourceMetas, SYS_RESOURCE_NAME } from './meta.ts'

/** 仅注册 sys_setting；业务设置 Meta 由各域 register*SettingResources 注册 */
export function registerSettingResources(registry: Registry): void {
  for (const meta of allSettingResourceMetas()) {
    registry.register(meta)
  }
}
