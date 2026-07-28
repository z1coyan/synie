import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const page = source('./setup.tsx')
const setupFacade = source('../lib/setup.ts')

describe('Setup 页面 REST 迁移契约', () => {
  test('Setup facade 封装四个 REST 动作（hc api.setup.*）', () => {
    for (const marker of [
      'api.setup.status.$get',
      "api.setup['first-user'].$post",
      "api.setup.currencies['seed-common'].$post",
      "api.setup.currencies['activate-base'].$post",
      'api.setup.complete.$post',
    ]) {
      expect(setupFacade).toContain(marker)
    }
    expect(setupFacade).not.toContain('gqlFetch')
    expect(setupFacade).not.toContain('openapi-fetch')
  })

  test('页面登录和资源操作复用 REST helper/client', () => {
    for (const marker of [
      'loginSession(username, password)',
      'companyClient.query',
      'companyClient.create',
      'currencyClient.query',
      'accountClient.query',
      'initializeAccountTemplate',
    ]) {
      expect(page).toContain(marker)
    }
    expect(page).not.toContain('gqlFetch')
    expect(page).not.toMatch(/`\s*(?:query|mutation)\b/)
  })

  test('公司创建依赖后端原子三仓且不重复 seed', () => {
    expect(page).toContain('3 个默认仓库')
    expect(page).not.toContain('seedWarehouseDefaults')
    expect(page).not.toContain('seedInvWarehouseDefaults')
  })

  test('示例路径可选并按选择提交 seedSampleData', () => {
    expect(page).not.toContain('Go 示例数据迁移尚未完成')
    expect(page).toContain("'sample'")
    expect(page).toContain('seedSampleData={path === \'sample\'}')
    expect(page).toContain('completeSetup(language, props.seedSampleData)')
    expect(page).toContain('title="示例数据"')
    expect(page).toContain('title="空白项目"')
  })
})
