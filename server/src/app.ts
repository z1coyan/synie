import { Hono, type MiddlewareHandler } from 'hono'
import { requestId } from 'hono/request-id'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from './db/types.ts'
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
 * 应用依赖。核心三项（db/auth/registry）+ 工单 01 平台四模块均必选；
 * 业务域模块落地后在此接口上继续追加字段，并在 buildApp 中 `.route()` 挂载。
 *
 * 约定（保 hc 类型链）：
 * - 新增模块用工厂闭包产出 service + routes，经 deps 注入，禁止全局单例
 * - 路由必须链式 `.route()` + zValidator，否则 ApiType 断链
 * - 未实现的模块不要占位空壳 service / 假路由
 *
 * 挂载面（对齐 server-go / OpenAPI）：
 * - settings  → GET|PATCH `/settings/{supply-chain,production,finance,system}`
 * - numbering → `/system/numbering/...`（规则 CRUD + 取号/校正）
 * - files     → `/files`、`/system/storages`
 * - audit     → 写钩子 + `/system/audit-logs` 查询面
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

/**
 * 应用装配。全部业务路径挂在 /api/v1 下（与 server-go 及前端代理约定一致）；
 * 鉴权按路由显式声明（requireAuth），公开路径只有 healthz / auth/login
 * （以及将来的 setup/*，见工单 16-setup-wizard）。
 *
 * hc<ApiType> 依赖链式定义推断路由类型，新增模块务必用 .route() 挂载、
 * 输入走 zValidator，否则前端 hono/client 拿不到类型。
 */
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

  app.onError(onError)
  app.notFound(notFound)
  return app
}

/** hono/client 的类型源：web 与 e2e 以此获得全链路类型 */
export type ApiType = ReturnType<typeof buildApp>
