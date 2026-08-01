import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertNoConvexCloudSelection,
  isolatedComposeEnv,
  root,
  selfHostedConvexCliEnv,
} from './lib.ts'

describe('isolatedComposeEnv', () => {
  test('隔离 Compose 无条件绑定 loopback 且保留其余环境覆盖', () => {
    const result = isolatedComposeEnv(
      {
        COMPOSE_PROJECT_NAME: 'synie-isolated-test',
        SYNIE_BIND_HOST: '0.0.0.0',
      },
      {
        CONVEX_VERSION: '0'.repeat(40),
        SYNIE_BIND_HOST: '0.0.0.0',
        UNRELATED_VALUE: 'preserved',
      },
    )

    expect(result).toMatchObject({
      COMPOSE_PROJECT_NAME: 'synie-isolated-test',
      SYNIE_BIND_HOST: '127.0.0.1',
      UNRELATED_VALUE: 'preserved',
    })
  })
})

describe('Docker build context', () => {
  test('本地管理员凭据与 Convex 备份绝不进入 build context', () => {
    const ignored = new Set(
      readFileSync(join(root, '.dockerignore'), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    )

    expect(ignored.has('infra/convex/backups')).toBe(true)
    expect(ignored.has('infra/convex/backups/**')).toBe(true)
  })
})

describe('selfHostedConvexCliEnv', () => {
  test('拒绝所有优先于 self-hosted admin key 的 cloud 选择变量', () => {
    for (const name of [
      'CONVEX_DEPLOY_KEY',
      'CONVEX_DEPLOYMENT_TOKEN',
      'CONVEX_DEPLOYMENT',
      'CONVEX_OVERRIDE_ACCESS_TOKEN',
    ]) {
      expect(() =>
        assertNoConvexCloudSelection({ [name]: 'cloud-value' }),
      ).toThrow(name)
    }
  })

  test('只在 URL 与 admin key 同时存在时构造 self-hosted CLI 环境', () => {
    expect(() => selfHostedConvexCliEnv({})).toThrow('URL/admin key')
    const result = selfHostedConvexCliEnv({
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'local-admin-key',
      CONVEX_DEPLOY_KEY: '',
      CONVEX_DEPLOYMENT: '',
      KEEP: 'yes',
    })
    expect(result).toMatchObject({
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'local-admin-key',
      KEEP: 'yes',
    })
    expect('CONVEX_DEPLOY_KEY' in result).toBe(false)
    expect('CONVEX_DEPLOYMENT' in result).toBe(false)
  })
})
