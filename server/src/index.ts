import { createMarketScheduler } from './jobs/index.ts'
import { buildApp } from './app.ts'
import { createServices, toAppDeps } from './composition.ts'
import { createDb } from './db/index.ts'
import { loadEnv } from './env.ts'
import { createBetterAuth } from './platform/auth/better-auth.ts'
import { createRateLimiter } from './platform/auth/limiter.ts'
import { createAuthService } from './platform/auth/service.ts'
import { createAuthStore } from './platform/auth/store.ts'
import { createTokenManager } from './platform/auth/token.ts'
import { createActorAssembler, createAuthzStore } from './platform/authz/index.ts'
import { createAuthzEnforcer } from './platform/authz/enforce.ts'
import { createRegistry } from './platform/meta/registry.ts'
import { registerAllResources } from './platform/meta/register-all.ts'
import { createSofficeConverter } from './platform/printing/index.ts'
import { logJson, serializeError } from './platform/http/log.ts'

const env = loadEnv()
const db = createDb(env.databaseUrl)

const tokens = createTokenManager({ secret: env.authSecret, ttlSeconds: env.tokenTtlSeconds })
const betterAuth = createBetterAuth({
  db,
  secret: env.authSecret,
  baseURL: env.betterAuthUrl,
  allowedHosts: env.betterAuthAllowedHosts,
  logto: env.logto,
})
// Registry 先于 Actor 装配：grants_all 展开以 sealed 权限目录为基准
const registry = createRegistry()
registerAllResources(registry)
const sealReport = registry.seal()
logJson('info', 'meta.catalog.sealed', {
  total: sealReport.total,
  normalized: sealReport.normalized,
})

const auth = await createAuthService({
  store: createAuthStore(db),
  actors: createActorAssembler({
    store: createAuthzStore(db),
    allPermissionCodes: () => registry.allPermissionCodes(),
  }),
  tokens,
  limiter: createRateLimiter(),
  betterAuth,
})

const services = createServices(db, {
  registry,
  tokens,
  converter: createSofficeConverter({
    path: env.sofficePath,
    timeoutMs: env.sofficeTimeoutMs,
    maxConcurrency: env.sofficeMaxConcurrency,
  }),
})

const app = buildApp({
  db,
  auth,
  betterAuth,
  logtoEnabled: Boolean(env.logto),
  registry,
  authz: createAuthzEnforcer(registry),
  ...toAppDeps(services),
})

const marketScheduler = createMarketScheduler({ settings: services.settings, market: services.market })
marketScheduler.start()

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
  error(err) {
    // Bun.serve 层未进入 Hono onError 的异常（如 fetch 本身抛错）
    logJson('error', 'bun_serve_error', { error: serializeError(err) })
    return new Response(
      JSON.stringify({ error: { code: 'internal', message: '服务内部错误，请稍后重试' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  },
})

logJson('info', 'synie server listening', { port: server.port, host: env.host })

async function shutdown() {
  marketScheduler.stop()
  server.stop()
  await db.destroy()
  process.exit(0)
}

process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})

/** 进程级兜底：绝不静默丢错误 */
process.on('unhandledRejection', (reason) => {
  logJson('error', 'unhandled_rejection', { error: serializeError(reason) })
})
process.on('uncaughtException', (err) => {
  logJson('error', 'uncaught_exception', { error: serializeError(err) })
})
