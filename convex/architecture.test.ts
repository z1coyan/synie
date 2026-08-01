/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'

const allowedRawEntrypoints = new Set([
  'convex/infraRestore.ts',
  'convex/lib/auth.ts',
  'convex/setup/createFirstUser.ts',
  'convex/setup/spike.ts',
  'convex/setup/status.ts',
  'convex/iam/loginRateLimit.ts',
  'convex/resources/probe.ts',
  'convex/test/engineProbe.ts',
])

describe('Convex public function boundary', () => {
  test('事实引擎不得逃离单 mutation 原子边界', async () => {
    const violations: string[] = []
    const glob = new Bun.Glob('convex/engines/**/*.ts')
    for await (const path of glob.scan({ cwd: '.', onlyFiles: true })) {
      if (path.endsWith('.test.ts')) continue
      const source = await Bun.file(path).text()
      for (const token of ['fetch(', 'scheduler', 'runMutation', '"use node"', "'use node'"]) {
        if (source.includes(token)) violations.push(`${path}: ${token}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('业务 query/mutation 必须经统一 Actor wrapper', async () => {
    const violations: string[] = []
    const glob = new Bun.Glob('convex/**/*.ts')
    for await (const path of glob.scan({ cwd: '.', onlyFiles: true })) {
      if (path.includes('/_generated/') || path.endsWith('.test.ts')) continue
      const source = await Bun.file(path).text()
      const importsRawFunction =
        /import\s*\{[^}]*\b(?:query|mutation)\b[^}]*\}\s*from\s*['"][^'"]*_generated\/server['"]/.test(
          source,
        )
      if (importsRawFunction && !allowedRawEntrypoints.has(path)) violations.push(path)
    }
    expect(violations).toEqual([])
  })

  test('运行时代码不硬编码 Convex Cloud 域名', async () => {
    const hits: string[] = []
    const glob = new Bun.Glob('{convex,web/app}/**/*.{ts,tsx}')
    for await (const path of glob.scan({ cwd: '.', onlyFiles: true })) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      if ((await Bun.file(path).text()).includes('convex.cloud')) hits.push(path)
    }
    expect(hits).toEqual([])
  })

  test('pilot 资源查询禁止 filter/collect 和无索引读取', async () => {
    const violations: string[] = []
    for (const path of [
      'convex/resources/currencies.ts',
      'convex/resources/units.ts',
      'convex/resources/warehouses.ts',
    ]) {
      const source = await Bun.file(path).text()
      if (source.includes('.filter(') || source.includes('.collect(')) {
        violations.push(`${path}: scan primitive`)
      }
      for (const match of source.matchAll(/\.query\(['"][^'"]+['"]\)([\s\S]{0,500}?)(?:\.paginate\(|\.first\(|\.unique\()/g)) {
        if (!match[1]?.includes('.withIndex(') && !match[1]?.includes('.withSearchIndex(')) {
          violations.push(`${path}: unindexed query`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
