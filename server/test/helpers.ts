import type { Kysely } from 'kysely'
import { buildApp, type AppDeps, type ApiType } from '~/app.ts'
import type { DB as Database } from '~/db/types.ts'
import { createRateLimiter } from '~/platform/auth/limiter.ts'
import { createAuthService, type AuthService } from '~/platform/auth/service.ts'
import { createAuthStore } from '~/platform/auth/store.ts'
import { createTokenManager } from '~/platform/auth/token.ts'
import { createAuditService, registerAuditResources, type AuditService } from '~/platform/audit/index.ts'
import {
  createFileService,
  createOwnerRegistry,
  createStorageService,
  registerFileResources,
  type FileService,
  type OwnerRegistry,
  type StorageService,
} from '~/platform/files/index.ts'
import { createRegistry, type Registry } from '~/platform/meta/registry.ts'
import {
  createNumberingService,
  registerNumberingResources,
  type NumberingService,
} from '~/platform/numbering/index.ts'
import {
  createSettingsService,
  registerSettingResources,
  type SettingsService,
} from '~/platform/settings/index.ts'

/**
 * PG 集成测试轻量 helpers。
 * 门控惯例同 server-go：未设置 SYNIE_TEST_DATABASE_URL 时整组 Skip。
 * 平台/业务模块补集成测试时复用，避免每文件复制 auth/平台装配样板。
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

/** 创建并注册工单 01 平台 Meta 的 Registry */
export function createPlatformRegistry(): Registry {
  const registry = createRegistry()
  registerSettingResources(registry)
  registerNumberingResources(registry)
  registerFileResources(registry)
  registerAuditResources(registry)
  return registry
}

export interface PlatformServices {
  settings: SettingsService
  numbering: NumberingService
  files: FileService
  storages: StorageService
  audit: AuditService
  owners: OwnerRegistry
}

/** 与 index.ts 同构的平台服务（owners 默认为空注册表，可被调用方继续 register） */
export function createPlatformServices(db: Kysely<Database>): PlatformServices {
  const owners = createOwnerRegistry()
  return {
    settings: createSettingsService(db),
    numbering: createNumberingService(db),
    files: createFileService({ db, owners }),
    storages: createStorageService({ db }),
    audit: createAuditService(db),
    owners,
  }
}

export interface TestAppOptions {
  /** 覆盖默认 auth；默认 createTestAuth(db) */
  auth?: AuthService
  /** 覆盖默认已注册平台 Meta 的 registry */
  registry?: Registry
  /**
   * 覆盖平台服务字段。
   * 未传时由 createPlatformServices 装配完整 settings/numbering/files/storages/audit。
   */
  deps?: Partial<Omit<AppDeps, 'db' | 'auth' | 'registry'>>
  /** 自定义 owners 注册后的 FileService 等；优先于 deps.files */
  platform?: Partial<PlatformServices>
}

/** 装配可 request() 的测试应用（不 listen） */
export async function buildTestApp(
  db: Kysely<Database>,
  options: TestAppOptions = {},
): Promise<ApiType> {
  const auth = options.auth ?? (await createTestAuth(db))
  const registry = options.registry ?? createPlatformRegistry()
  const platform = createPlatformServices(db)
  const merged = { ...platform, ...options.platform, ...options.deps }
  return buildApp({
    db,
    auth,
    registry,
    settings: merged.settings,
    numbering: merged.numbering,
    files: merged.files,
    storages: merged.storages,
    audit: merged.audit,
  })
}
