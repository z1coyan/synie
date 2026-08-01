import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedComposeEnv, root } from './lib.ts'

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
