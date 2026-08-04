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
