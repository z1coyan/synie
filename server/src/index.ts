import { createFileCleanScheduler, createMarketScheduler } from './jobs/index.ts'
import { assertMigrationsCurrent } from '../db/migration-check.ts'
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
import { createWebhookErrorReporter } from './platform/http/error-report.ts'
import { createInflightTracker } from './platform/http/inflight.ts'
import { logJson, serializeError, setLogLevel } from './platform/http/log.ts'

const env = loadEnv()
// LOG_LEVEL 生效：低于该级别的日志不再输出（5xx 走 error 级别，始终可见）
setLogLevel(env.logLevel)

// BETTER_AUTH_URL 落 loopback 时白名单被自动放宽（env.ts 纯解析层不打日志，在此提示）
if (env.loopbackAutoAllowedHosts.length > 0) {
  logJson('warn', 'better_auth_hosts_auto_relaxed', {
    patterns: env.loopbackAutoAllowedHosts,
    hint: 'BETTER_AUTH_URL 落在 loopback，已自动放行局域网/Tailscale 同端口入口；生产部署请将 BETTER_AUTH_URL 设为公网 origin 以收紧信任面',
  })
}

const db = createDb(env.databaseUrl, {
  max: env.pgPool.max,
  idleTimeoutSeconds: env.pgPool.idleTimeoutSeconds,
  connectTimeoutSeconds: env.pgPool.connectTimeoutSeconds,
})

// 启动迁移版本校验：磁盘迁移与 synie_schema_migration 比对，落后拒绝启动
// （SKIP_MIGRATION_CHECK=true 仅供特殊场景旁路）
if (!env.skipMigrationCheck) {
  try {
    await assertMigrationsCurrent(db)
  } catch (err) {
    logJson('error', 'migration_check_failed', { error: serializeError(err) })
    process.exit(1)
  }
}

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
  db,
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

// 5xx 上报 webhook（不配 ERROR_REPORT_WEBHOOK_URL 则不启用，零行为变化）
const errorReporter = env.errorReportWebhookUrl
  ? createWebhookErrorReporter({ url: env.errorReportWebhookUrl })
  : undefined

// 重资源端点限流（按用户分桶，单进程滑窗；阈值 env RATE_LIMIT_*_PER_MIN 可配）
const rateLimiters = {
  upload: createRateLimiter({ max: env.rateLimit.uploadPerMin, windowMs: 60_000 }),
  printRender: createRateLimiter({ max: env.rateLimit.printPerMin, windowMs: 60_000 }),
  bankImport: createRateLimiter({ max: env.rateLimit.bankImportPerMin, windowMs: 60_000 }),
}

// 停机排空：在途请求计数（挂最外层中间件）
const inflight = createInflightTracker()

const app = buildApp({
  db,
  errorReporter,
  inflight: inflight.middleware,
  rateLimiters,
  auth,
  betterAuth,
  logtoEnabled: Boolean(env.logto),
  registry,
  authz: createAuthzEnforcer(registry),
  ...toAppDeps(services),
})

const marketScheduler = createMarketScheduler({ settings: services.settings, market: services.market })
marketScheduler.start()

// 文件存储对账 janitor：每日一次，默认 dry-run（FILE_RECON_* 见 env.ts）
const fileCleanScheduler = createFileCleanScheduler({
  settings: services.settings,
  reconcile: services.fileReconcile,
  enabled: env.fileRecon.enabled,
  dryRun: env.fileRecon.dryRun,
  orphanGraceMs: env.fileRecon.orphanGraceMs,
  runHour: env.fileRecon.runHour,
})
fileCleanScheduler.start()

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

let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  marketScheduler.stop()
  fileCleanScheduler.stop()
  // 先停止接收新连接，再等在途请求归零（超时强退兜底，防悬挂请求卡死停机）
  server.stop()
  const drainDeadline = Bun.sleep(env.shutdownDrainTimeoutMs).then(() => 'timeout' as const)
  const drainedAll = inflight.drained().then(() => 'drained' as const)
  const outcome = await Promise.race([drainedAll, drainDeadline])
  if (outcome === 'timeout') {
    logJson('warn', 'shutdown_drain_timeout', {
      timeoutMs: env.shutdownDrainTimeoutMs,
      inflight: inflight.count(),
    })
  }
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
