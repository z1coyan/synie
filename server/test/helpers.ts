import type { Kysely } from 'kysely'
import { buildApp, type AppDeps, type ApiType } from '~/app.ts'
import type { DB as Database } from '~/db/types.ts'
import { createRateLimiter } from '~/platform/auth/limiter.ts'
import { createAuthService, type AuthService } from '~/platform/auth/service.ts'
import { createAuthStore } from '~/platform/auth/store.ts'
import { createTokenManager } from '~/platform/auth/token.ts'
import { createRegistry, type Registry } from '~/platform/meta/registry.ts'

/**
 * PG 集成测试轻量 helpers。
 * 门控惯例同 server-go：未设置 SYNIE_TEST_DATABASE_URL 时整组 Skip。
 * 平台/业务模块补集成测试时复用，避免每文件复制 auth 样板。
 */

/** 集成测试用固定密钥（≥32 字节）；仅测试进程内使用 */
export const TEST_AUTH_SECRET = 'integration-test-secret-32-bytes!!'

/** 读门控变量；未设置返回 undefined（调用方 describe.skip） */
export function testDatabaseUrl(): string | undefined {
  return process.env.SYNIE_TEST_DATABASE_URL
}

/** 与 index.ts 同构的测试 AuthService（固定 secret / 1h TTL / 进程内限流） */
export async function createTestAuth(db: Kysely<Database>): Promise<AuthService> {
  return createAuthService({
    store: createAuthStore(db),
    tokens: createTokenManager({ secret: TEST_AUTH_SECRET, ttlSeconds: 3600 }),
    limiter: createRateLimiter(),
  })
}

export interface TestAppOptions {
  /** 覆盖默认 auth；默认 createTestAuth(db) */
  auth?: AuthService
  /** 覆盖默认空 registry */
  registry?: Registry
  /**
   * 合并进 AppDeps 的额外字段。
   * 工单 01 起平台模块实现后可传入 settings/numbering/… 等扩展 deps。
   */
  deps?: Omit<Partial<AppDeps>, 'db' | 'auth' | 'registry'>
}

/** 装配可 request() 的测试应用（不 listen） */
export async function buildTestApp(
  db: Kysely<Database>,
  options: TestAppOptions = {},
): Promise<ApiType> {
  const auth = options.auth ?? (await createTestAuth(db))
  const registry = options.registry ?? createRegistry()
  return buildApp({
    db,
    auth,
    registry,
    ...options.deps,
  })
}
