import { buildApp } from './app.ts'
import { createDb } from './db/index.ts'
import { loadEnv } from './env.ts'
import { createRateLimiter } from './platform/auth/limiter.ts'
import { createAuthService } from './platform/auth/service.ts'
import { createAuthStore } from './platform/auth/store.ts'
import { createTokenManager } from './platform/auth/token.ts'
import { createRegistry } from './platform/meta/registry.ts'

const env = loadEnv()
const db = createDb(env.databaseUrl)

const auth = await createAuthService({
  store: createAuthStore(db),
  tokens: createTokenManager({ secret: env.authSecret, ttlSeconds: env.tokenTtlSeconds }),
  limiter: createRateLimiter(),
})

// 业务资源注册（registerAll）：随各业务模块落地逐个挂载，骨架期为空表。
const registry = createRegistry()

// --- 工单 01 平台服务装配点 ---
// 实现落地后在此 createXxxService({ db, ... }) 并传入 buildApp：
//   settings / numbering / audit / files（见各 platform/*/README.md）
// 未实现前不要注入空壳；buildApp 扩展点见 app.ts 注释。
const app = buildApp({ db, auth, registry })

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
