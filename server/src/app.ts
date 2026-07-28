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

/**
 * 应用依赖。核心三项（db/auth/registry）已落地；
 * 平台业务模块（settings / numbering / audit / files）由工单 01 各领域实现后
 * 在此接口上**显式追加必选字段**并在 buildApp 中 `.route()` 挂载。
 *
 * 约定（保 hc 类型链）：
 * - 新增模块用工厂闭包产出 service + routes，经 deps 注入，禁止全局单例
 * - 路由必须链式 `.route()` + zValidator，否则 ApiType 断链
 * - 未实现的模块不要占位空壳 service / 假路由
 *
 * 预期挂载面（对齐 server-go / OpenAPI，路径仅作备忘）：
 * - settings  → GET|PATCH `/{sys,acc,sales,mfg}/setting`
 * - numbering → `/system/numbering/...`（规则 CRUD + 取号/校正）
 * - files     → `/files`、`/system/storage`、attachments 挂接
 * - audit     → 主要为写路径 service 钩子；REST 以 server-go 为准（可能无独立资源面）
 */
export interface AppDeps {
  db: Kysely<Database>
  auth: AuthService
  registry: Registry
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
 *
 * --- 扩展点（工单 01+）---
 * 在下方 `.route('/meta', ...)` 之后继续链式挂载平台/业务路由，例如：
 *   .route('/', settingsRoutes(deps.settings, deps.auth))
 *   .route('/system/numbering', numberingRoutes(deps.numbering, deps.auth))
 *   .route('/files', filesRoutes(deps.files, deps.auth))
 * 同步扩展 {@link AppDeps} 与 `index.ts` 装配。
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
  // ↑ 平台扩展挂载点：settings / numbering / files / … 在此继续链式 .route()
  //   （audit 若无 REST 则只经 service 注入业务写路径，不必在此挂路由）

  app.onError(onError)
  app.notFound(notFound)
  return app
}

/** hono/client 的类型源：web 与 e2e 以此获得全链路类型 */
export type ApiType = ReturnType<typeof buildApp>
