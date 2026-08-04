import type { Kysely } from 'kysely'
import { buildApp, type ApiType } from '~/app.ts'
import { createServices, toAppDeps, type Services } from '~/composition.ts'
import type { DB as Database } from '~/db/types.ts'
import { createBetterAuth, type SynieBetterAuth } from '~/platform/auth/better-auth.ts'
import { createRateLimiter } from '~/platform/auth/limiter.ts'
import { createAuthService, type AuthService } from '~/platform/auth/service.ts'
import { createAuthStore } from '~/platform/auth/store.ts'
import { createActorAssembler, createAuthzStore } from '~/platform/authz/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createTokenManager } from '~/platform/auth/token.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import type { Registry } from '~/platform/meta/registry.ts'

/** 集成测试用固定密钥（≥32 字节）；仅测试进程内使用 */
export const TEST_AUTH_SECRET = 'integration-test-secret-32-bytes!!'

/** 读门控变量；未设置返回 undefined（调用方 describe.skip） */
export function testDatabaseUrl(): string | undefined {
  return process.env.SYNIE_TEST_DATABASE_URL
}

/** 与生产同构的 better-auth 实例（固定 secret；Logto 不注册） */
export function createTestBetterAuth(db: Kysely<Database>): SynieBetterAuth {
  return createBetterAuth({ db, secret: TEST_AUTH_SECRET })
}

/** 与生产同构的测试 AuthService（固定 secret / 1h TTL / 进程内限流；可挂 cookie 轨） */
export async function createTestAuth(
  db: Kysely<Database>,
  betterAuth?: SynieBetterAuth,
  registry?: Registry,
): Promise<AuthService> {
  const codes = registry ?? createSealedResourceRegistry()
  return createAuthService({
    store: createAuthStore(db),
    actors: createActorAssembler({
      store: createAuthzStore(db),
      allPermissionCodes: () => codes.allPermissionCodes(),
      // 测试内多次改授权后立即重读：关掉 TTL 缓存
      ttlMs: 0,
    }),
    tokens: createTokenManager({ secret: TEST_AUTH_SECRET, ttlSeconds: 3600 }),
    limiter: createRateLimiter(),
    betterAuth,
  })
}

/** 与生产同构的完整资源 Registry（统一走 registerAllResources） */
export function createPlatformRegistry(): Registry {
  return createSealedResourceRegistry()
}

export interface TestAppOptions {
  auth?: AuthService
  betterAuth?: SynieBetterAuth
  registry?: Registry
  deps?: Partial<Services>
}

/** 装配可 request() 的测试应用（不 listen）；服务图与生产同走 composition.ts */
export async function buildTestApp(
  db: Kysely<Database>,
  options: TestAppOptions = {},
): Promise<ApiType> {
  const betterAuth = options.betterAuth ?? createTestBetterAuth(db)
  const registry = options.registry ?? createPlatformRegistry()
  const auth = options.auth ?? (await createTestAuth(db, betterAuth, registry))
  const services = createServices(db, {
    registry,
    tokens: createTokenManager({ secret: TEST_AUTH_SECRET, ttlSeconds: 3600 }),
    overrides: options.deps,
  })
  return buildApp({
    db,
    auth,
    betterAuth,
    logtoEnabled: false,
    registry,
    authz: createAuthzEnforcer(registry),
    ...toAppDeps(services),
  })
}
