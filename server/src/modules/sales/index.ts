import type { Registry } from '~/platform/meta/registry.ts'
import { companyAccountDefaultMeta } from './company-account-default.ts'

export {
  createCompanyAccountDefaultService,
  companyAccountDefaultMeta,
  DEFAULT_RESOURCE,
  type CompanyAccountDefaultService,
} from './company-account-default.ts'
export { companyAccountDefaultRoutes } from './routes.ts'

export function registerSalesCompanyAccountDefault(registry: Registry): void {
  registry.register(companyAccountDefaultMeta())
}
