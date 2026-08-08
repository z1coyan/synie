import { describe, expect, test } from 'bun:test'
import { loadEnv } from '~/env.ts'

const base = {
  AUTH_SECRET: 'unit-test-secret-that-is-32-bytes!!',
  DATABASE_URL: 'postgres://synie:synie@localhost:5441/synie?sslmode=disable',
}

describe('env Logto 门控（要么全有要么全无）', () => {
  test('三件套全缺省：logto undefined', () => {
    const env = loadEnv({ ...base })
    expect(env.logto).toBeUndefined()
  })

  test('三件套齐备且带 BETTER_AUTH_URL：logto 解析成功', () => {
    const env = loadEnv({
      ...base,
      BETTER_AUTH_URL: 'http://localhost:3000/',
      LOGTO_ISSUER: 'https://example.logto.app/oidc',
      LOGTO_CLIENT_ID: 'client-id',
      LOGTO_CLIENT_SECRET: 'client-secret',
    })
    expect(env.betterAuthUrl).toBe('http://localhost:3000')
    // localhost 附带 127.0.0.1 + 局域网/Tailscale 通配（仅 loopback BETTER_AUTH_URL）
    expect(env.betterAuthAllowedHosts).toContain('localhost:3000')
    expect(env.betterAuthAllowedHosts).toContain('127.0.0.1:3000')
    expect(env.betterAuthAllowedHosts).toContain('100.*.*.*:3000')
    expect(env.betterAuthAllowedHosts).toContain('*.ts.net:3000')
    expect(env.logto).toEqual({
      issuer: 'https://example.logto.app/oidc',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })
  })

  test('BETTER_AUTH_ALLOWED_HOSTS 与 BETTER_AUTH_URL 合并去重', () => {
    const env = loadEnv({
      ...base,
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_ALLOWED_HOSTS: 'home-n5pro:3000, localhost:3000',
    })
    expect(env.betterAuthAllowedHosts[0]).toBe('localhost:3000')
    expect(env.betterAuthAllowedHosts).toContain('home-n5pro:3000')
    expect(env.betterAuthAllowedHosts).toContain('127.0.0.1:3000')
  })

  test('生产公网 BETTER_AUTH_URL 不自动扩局域网', () => {
    const env = loadEnv({
      ...base,
      BETTER_AUTH_URL: 'https://erp.example.com',
    })
    expect(env.betterAuthAllowedHosts).toEqual(['erp.example.com'])
  })

  test('三件套齐备但缺 BETTER_AUTH_URL：拒绝启动', () => {
    expect(() =>
      loadEnv({
        ...base,
        LOGTO_ISSUER: 'https://example.logto.app/oidc',
        LOGTO_CLIENT_ID: 'client-id',
        LOGTO_CLIENT_SECRET: 'client-secret',
      }),
    ).toThrow('BETTER_AUTH_URL')
  })

  test('只给部分：拒绝启动', () => {
    expect(() =>
      loadEnv({ ...base, LOGTO_ISSUER: 'https://example.logto.app/oidc' }),
    ).toThrow('必须同时设置或同时缺省')
    expect(() =>
      loadEnv({ ...base, LOGTO_CLIENT_ID: 'client-id', LOGTO_CLIENT_SECRET: 'secret' }),
    ).toThrow('必须同时设置或同时缺省')
  })

  test('ISSUER 必须是 URL', () => {
    expect(() =>
      loadEnv({
        ...base,
        BETTER_AUTH_URL: 'http://localhost:3000',
        LOGTO_ISSUER: 'not-a-url',
        LOGTO_CLIENT_ID: 'client-id',
        LOGTO_CLIENT_SECRET: 'secret',
      }),
    ).toThrow('环境配置无效')
  })
})

describe('env 文件存储对账（FILE_RECON_*）', () => {
  test('缺省：启用、dry-run、3 点、24h 宽限', () => {
    const env = loadEnv({ ...base })
    expect(env.fileRecon).toEqual({
      enabled: true,
      dryRun: true,
      runHour: 3,
      orphanGraceMs: 24 * 3600_000,
    })
  })

  test('显式配置生效', () => {
    const env = loadEnv({
      ...base,
      FILE_RECON_ENABLED: 'false',
      FILE_RECON_DRY_RUN: 'false',
      FILE_RECON_RUN_HOUR: '5',
      FILE_RECON_ORPHAN_GRACE_HOURS: '48',
    })
    expect(env.fileRecon).toEqual({
      enabled: false,
      dryRun: false,
      runHour: 5,
      orphanGraceMs: 48 * 3600_000,
    })
  })

  test('非法布尔与越界时刻拒绝启动', () => {
    expect(() => loadEnv({ ...base, FILE_RECON_DRY_RUN: 'maybe' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, FILE_RECON_RUN_HOUR: '24' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, FILE_RECON_ORPHAN_GRACE_HOURS: '0' })).toThrow('环境配置无效')
  })
})

describe('env 可观测性配置', () => {
  test('LOG_LEVEL 缺省 info；合法值透传', () => {
    expect(loadEnv({ ...base }).logLevel).toBe('info')
    expect(loadEnv({ ...base, LOG_LEVEL: 'error' }).logLevel).toBe('error')
  })

  test('LOG_LEVEL 非法值拒绝启动（枚举式校验）', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'INFO' })).toThrow('环境配置无效')
  })

  test('ERROR_REPORT_WEBHOOK_URL 缺省不启用；合法 URL 透传', () => {
    expect(loadEnv({ ...base }).errorReportWebhookUrl).toBeUndefined()
    const env = loadEnv({ ...base, ERROR_REPORT_WEBHOOK_URL: 'https://hooks.example.com/synie' })
    expect(env.errorReportWebhookUrl).toBe('https://hooks.example.com/synie')
  })

  test('ERROR_REPORT_WEBHOOK_URL 非法 URL 拒绝启动', () => {
    expect(() => loadEnv({ ...base, ERROR_REPORT_WEBHOOK_URL: 'not-a-url' })).toThrow('环境配置无效')
  })
})

describe('env 连接池（PG_POOL_*）', () => {
  test('缺省：max 10、idle 0（不回收）、connect 30s', () => {
    const env = loadEnv({ ...base })
    expect(env.pgPool).toEqual({ max: 10, idleTimeoutSeconds: 0, connectTimeoutSeconds: 30 })
  })

  test('显式配置生效', () => {
    const env = loadEnv({
      ...base,
      PG_POOL_MAX: '20',
      PG_POOL_IDLE_TIMEOUT_S: '60',
      PG_POOL_CONNECT_TIMEOUT_S: '5',
    })
    expect(env.pgPool).toEqual({ max: 20, idleTimeoutSeconds: 60, connectTimeoutSeconds: 5 })
  })

  test('非法值拒绝启动', () => {
    expect(() => loadEnv({ ...base, PG_POOL_MAX: '0' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, PG_POOL_MAX: 'abc' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, PG_POOL_IDLE_TIMEOUT_S: '-1' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, PG_POOL_CONNECT_TIMEOUT_S: '0' })).toThrow('环境配置无效')
  })
})

describe('env 停机排空与迁移校验开关', () => {
  test('缺省：排空 10s、开启迁移校验', () => {
    const env = loadEnv({ ...base })
    expect(env.shutdownDrainTimeoutMs).toBe(10_000)
    expect(env.skipMigrationCheck).toBe(false)
  })

  test('显式配置生效', () => {
    const env = loadEnv({ ...base, SHUTDOWN_DRAIN_TIMEOUT_MS: '3000', SKIP_MIGRATION_CHECK: 'true' })
    expect(env.shutdownDrainTimeoutMs).toBe(3000)
    expect(env.skipMigrationCheck).toBe(true)
  })

  test('非法值拒绝启动', () => {
    expect(() => loadEnv({ ...base, SHUTDOWN_DRAIN_TIMEOUT_MS: '0' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, SKIP_MIGRATION_CHECK: 'maybe' })).toThrow('环境配置无效')
  })
})

describe('env 重资源限流阈值（RATE_LIMIT_*_PER_MIN）', () => {
  test('缺省：上传 30 / 打印 20 / 银行导入 10（次/分钟/用户）', () => {
    const env = loadEnv({ ...base })
    expect(env.rateLimit).toEqual({ uploadPerMin: 30, printPerMin: 20, bankImportPerMin: 10 })
  })

  test('显式配置生效', () => {
    const env = loadEnv({
      ...base,
      RATE_LIMIT_UPLOAD_PER_MIN: '60',
      RATE_LIMIT_PRINT_PER_MIN: '5',
      RATE_LIMIT_BANK_IMPORT_PER_MIN: '3',
    })
    expect(env.rateLimit).toEqual({ uploadPerMin: 60, printPerMin: 5, bankImportPerMin: 3 })
  })

  test('非法值拒绝启动', () => {
    expect(() => loadEnv({ ...base, RATE_LIMIT_UPLOAD_PER_MIN: '0' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, RATE_LIMIT_PRINT_PER_MIN: '-1' })).toThrow('环境配置无效')
    expect(() => loadEnv({ ...base, RATE_LIMIT_BANK_IMPORT_PER_MIN: 'x' })).toThrow('环境配置无效')
  })
})

describe('env loopback 自动放宽透出（启动 warn 依据）', () => {
  test('loopback BETTER_AUTH_URL：透出 5 条通配段', () => {
    const env = loadEnv({ ...base, BETTER_AUTH_URL: 'http://localhost:3000' })
    expect(env.loopbackAutoAllowedHosts).toEqual([
      '10.*.*.*:3000',
      '192.168.*.*:3000',
      '172.*.*.*:3000',
      '100.*.*.*:3000',
      '*.ts.net:3000',
    ])
  })

  test('公网 BETTER_AUTH_URL / 未配置：不放宽', () => {
    expect(loadEnv({ ...base, BETTER_AUTH_URL: 'https://erp.example.com' }).loopbackAutoAllowedHosts).toEqual([])
    expect(loadEnv({ ...base }).loopbackAutoAllowedHosts).toEqual([])
  })
})
