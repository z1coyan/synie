import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createAccountService } from './account-service.ts'
import { createCompanyService } from './company-service.ts'
import { createCurrencyService } from './currency-service.ts'
import { allBaseResourceMetas } from './meta.ts'
import { createUnitService } from './unit-service.ts'

export { createCurrencyService, type CurrencyService } from './currency-service.ts'
export { createCompanyService, type CompanyService } from './company-service.ts'
export { createUnitService, type UnitService } from './unit-service.ts'
export { createAccountService, type AccountService } from './account-service.ts'
export { baseRoutes, type BaseRouteDeps } from './routes.ts'
export {
  currencyResourceMeta,
  companyResourceMeta,
  unitResourceMeta,
  accountResourceMeta,
  allBaseResourceMetas,
  CURRENCY_RESOURCE_NAME,
  COMPANY_RESOURCE_NAME,
  UNIT_RESOURCE_NAME,
  ACCOUNT_RESOURCE_NAME,
} from './meta.ts'
export { seedCompanyDefaultWarehouses } from './warehouse-seed.ts'

export function registerBaseResources(registry: Registry): void {
  for (const meta of allBaseResourceMetas()) {
    registry.register(meta)
  }
}

/** 装配 base 四资源服务（公司/货币/单位/科目）；registry 提供授权归宿声明，numbering 供公司种子默认仓取号 */
export function createBaseServices(db: Kysely<Database>, numbering: NumberingService, registry: Registry) {
  return {
    currencies: createCurrencyService(db, registry),
    companies: createCompanyService(db, numbering, registry),
    units: createUnitService(db, registry),
    accounts: createAccountService(db, registry),
  }
}

export type BaseServices = ReturnType<typeof createBaseServices>
