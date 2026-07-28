import { Hono, type MiddlewareHandler } from 'hono'
import { requestId } from 'hono/request-id'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from './db/types.ts'
import { baseRoutes } from './modules/base/index.ts'
import type { AccountService } from './modules/base/account-service.ts'
import type { CompanyService } from './modules/base/company-service.ts'
import type { CurrencyService } from './modules/base/currency-service.ts'
import type { UnitService } from './modules/base/unit-service.ts'
import { iamRoleRoutes, iamUserRoutes } from './modules/iam/index.ts'
import type { IamService } from './modules/iam/service.ts'
import { customerRoutes, employeeRoutes, supplierRoutes } from './modules/party/index.ts'
import type {
  CustomerService,
  EmployeeService,
  SupplierService,
} from './modules/party/party-service.ts'
import { companyAccountDefaultRoutes } from './modules/sales/index.ts'
import type { CompanyAccountDefaultService } from './modules/sales/company-account-default.ts'
import { authRoutes } from './platform/auth/routes.ts'
import type { AuthService } from './platform/auth/service.ts'
import type { AppEnv } from './platform/http/context.ts'
import { notFound, onError } from './platform/http/errors.ts'
import { metaRoutes } from './platform/meta/routes.ts'
import type { Registry } from './platform/meta/registry.ts'
import { auditRoutes } from './platform/audit/routes.ts'
import type { AuditService } from './platform/audit/service.ts'
import { fileRoutes, storageRoutes } from './platform/files/routes.ts'
import type { FileService } from './platform/files/service.ts'
import type { StorageService } from './platform/files/storage-service.ts'
import { numberingRoutes } from './platform/numbering/routes.ts'
import type { NumberingService } from './platform/numbering/service.ts'
import { settingsRoutes } from './platform/settings/routes.ts'
import type { SettingsService } from './platform/settings/service.ts'

/**
 * 应用依赖。核心平台 + 工单 02 base/iam/party/公司默认过账科目。
 * 路由必须链式 .route() + zValidator，保 ApiType 类型链。
 */
export interface AppDeps {
  db: Kysely<Database>
  auth: AuthService
  registry: Registry
  settings: SettingsService
  numbering: NumberingService
  files: FileService
  storages: StorageService
  audit: AuditService
  currencies: CurrencyService
  companies: CompanyService
  units: UnitService
  accounts: AccountService
  iam: IamService
  customers: CustomerService
  suppliers: SupplierService
  employees: EmployeeService
  companyAccountDefaults: CompanyAccountDefaultService
}

const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now()
  await next()
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'http_request',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    }),
  )
}

export function buildApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .basePath('/api/v1')
    .use('*', requestId())
    .use('*', accessLog)
    .get('/healthz', async (c) => {
      try {
        await sql`select 1`.execute(deps.db)
        return c.json({ status: 'ok' })
      } catch {
        return c.json({ error: { code: 'internal', message: '数据库不可用' } }, 503)
      }
    })
    .route('/auth', authRoutes(deps.auth))
    .route('/meta', metaRoutes(deps.registry, deps.auth))
    .route('/settings', settingsRoutes({ auth: deps.auth, settings: deps.settings }))
    .route('/system/numbering', numberingRoutes({ auth: deps.auth, numbering: deps.numbering }))
    .route('/files', fileRoutes({ auth: deps.auth, files: deps.files }))
    .route('/system/storages', storageRoutes({ auth: deps.auth, storages: deps.storages }))
    .route('/system/audit-logs', auditRoutes({ auth: deps.auth, audit: deps.audit }))
    .route(
      '/base',
      baseRoutes({
        auth: deps.auth,
        currencies: deps.currencies,
        companies: deps.companies,
        units: deps.units,
        accounts: deps.accounts,
      }),
    )
    .route('/system/users', iamUserRoutes({ auth: deps.auth, iam: deps.iam }))
    .route('/system/roles', iamRoleRoutes({ auth: deps.auth, iam: deps.iam }))
    .route('/sales/customers', customerRoutes({ auth: deps.auth, customers: deps.customers }))
    .route('/purchase/suppliers', supplierRoutes({ auth: deps.auth, suppliers: deps.suppliers }))
    .route('/hr/employees', employeeRoutes({ auth: deps.auth, employees: deps.employees }))
    .route(
      '/sales/company-account-defaults',
      companyAccountDefaultRoutes({
        auth: deps.auth,
        defaults: deps.companyAccountDefaults,
      }),
    )

  app.onError(onError)
  app.notFound(notFound)
  return app
}

export type ApiType = ReturnType<typeof buildApp>
