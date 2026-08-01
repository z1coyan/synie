import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const WEB_APP_ROOT = join(REPO_ROOT, 'web/app')
const WEB_LIB_ROOT = join(WEB_APP_ROOT, 'lib')
const WEB_ROUTES_ROOT = join(WEB_APP_ROOT, 'routes')

const RETIRED_PATHS = [
  'web/app/lib/resources/meta.ts',
  'web/app/components/synie-record-drawer/registry.tsx',
] as const

function filesUnder(root: string): string[] {
  const entries = readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  }) as Dirent[]
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function isTypeScript(path: string): boolean {
  return path.endsWith('.ts') || path.endsWith('.tsx')
}

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path)
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/')
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1])
}

function resolvesIntoRoutes(from: string, specifier: string): boolean {
  if (specifier === '~/routes' || specifier.startsWith('~/routes/')) {
    return true
  }
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(from), specifier)
  return (
    target === WEB_ROUTES_ROOT || target.startsWith(`${WEB_ROUTES_ROOT}${sep}`)
  )
}

describe('前端架构依赖守卫', () => {
  test('legacy transport 与第二份 registry 文件保持删除', () => {
    for (const path of RETIRED_PATHS) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(false)
    }
  })

  test('生产前端不重新引入 GraphQL 或 OpenAPI transport', () => {
    const violations: string[] = []
    for (const path of filesUnder(WEB_APP_ROOT).filter(
      (file) => isTypeScript(file) && !isTest(file),
    )) {
      const source = readFileSync(path, 'utf8')
      if (
        /\bgqlFetch\b/.test(source) ||
        /\bapi\.graphql\b/.test(source) ||
        /(?:from\s+|import\s*\()\s*['"][^'"]*(?:graphql|openapi-fetch)[^'"]*['"]/i.test(
          source,
        )
      ) {
        violations.push(repoPath(path))
      }
    }
    expect(violations).toEqual([])
  })

  test('lib module 不反向依赖 routes，路由层保持组合根方向', () => {
    const violations: string[] = []
    for (const path of filesUnder(WEB_LIB_ROOT).filter(
      (file) => isTypeScript(file) && !isTest(file),
    )) {
      const source = readFileSync(path, 'utf8')
      for (const specifier of importSpecifiers(source)) {
        if (resolvesIntoRoutes(path, specifier)) {
          violations.push(`${repoPath(path)} -> ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('源码读取断言只允许集中在本架构守卫', () => {
    const readers = filesUnder(WEB_APP_ROOT)
      .filter((file) => isTypeScript(file) && isTest(file))
      .filter((file) => /\breadFileSync\b/.test(readFileSync(file, 'utf8')))
      .map(repoPath)
      .sort()

    expect(readers).toEqual([
      'web/app/lib/resources/architecture-guard.test.ts',
    ])
  })
})
