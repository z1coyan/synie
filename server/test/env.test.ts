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

  test('三件套齐备：logto 解析成功', () => {
    const env = loadEnv({
      ...base,
      LOGTO_ISSUER: 'https://example.logto.app/oidc',
      LOGTO_CLIENT_ID: 'client-id',
      LOGTO_CLIENT_SECRET: 'client-secret',
    })
    expect(env.logto).toEqual({
      issuer: 'https://example.logto.app/oidc',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })
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
        LOGTO_ISSUER: 'not-a-url',
        LOGTO_CLIENT_ID: 'client-id',
        LOGTO_CLIENT_SECRET: 'secret',
      }),
    ).toThrow('环境配置无效')
  })
})
