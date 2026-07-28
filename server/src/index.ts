import { buildApp } from './app.ts'
import { createDb } from './db/index.ts'
import { loadEnv } from './env.ts'
import { createRateLimiter } from './platform/auth/limiter.ts'
import { createAuthService } from './platform/auth/service.ts'
import { createAuthStore } from './platform/auth/store.ts'
import { createTokenManager } from './platform/auth/token.ts'
import { createAuditService, registerAuditResources } from './platform/audit/index.ts'
import {
  createFileService,
  createOwnerRegistry,
  createStorageService,
  registerFileResources,
} from './platform/files/index.ts'
import { createRegistry } from './platform/meta/registry.ts'
import { createNumberingService, registerNumberingResources } from './platform/numbering/index.ts'
import { createSettingsService, registerSettingResources } from './platform/settings/index.ts'

const env = loadEnv()
const db = createDb(env.databaseUrl)

const auth = await createAuthService({
  store: createAuthStore(db),
  tokens: createTokenManager({ secret: env.authSecret, ttlSeconds: env.tokenTtlSeconds }),
  limiter: createRateLimiter(),
})

const registry = createRegistry()
registerSettingResources(registry)
registerNumberingResources(registry)
registerFileResources(registry)
registerAuditResources(registry)

const settings = createSettingsService(db)
const numbering = createNumberingService(db)
const owners = createOwnerRegistry()
// 业务域宿主注册随各域落地；此处仅保留平台可挂接能力入口
const files = createFileService({ db, owners })
const storages = createStorageService({ db })
const audit = createAuditService(db)

const app = buildApp({
  db,
  auth,
  registry,
  settings,
  numbering,
  files,
  storages,
  audit,
})

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
})

console.log(JSON.stringify({ level: 'info', msg: 'synie server listening', port: server.port }))

process.on('SIGTERM', async () => {
  server.stop()
  await db.destroy()
  process.exit(0)
})
