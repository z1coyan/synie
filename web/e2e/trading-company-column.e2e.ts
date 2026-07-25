import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { DEMO_STATE_PATH } from './global-setup'
import type { DemoContext } from './helpers/admin-flow'

const TOKEN_KEY = 'synie:token'
const ROUTES = [
  '/scm/purchase/items',
  '/scm/purchase/orders',
  '/scm/purchase-quotations/items',
  '/scm/purchase-quotations/quotations',
  '/scm/quotations/items',
  '/scm/quotations/quotations',
  '/scm/sales-orders/items',
  '/scm/sales-orders/orders',
] as const

let demo: DemoContext

test.beforeAll(() => {
  demo = JSON.parse(readFileSync(DEMO_STATE_PATH, 'utf8')) as DemoContext
})

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    [TOKEN_KEY, demo.adminToken] as const,
  )
})

for (const route of ROUTES) {
  test(`${route} 首个业务列为公司`, async ({ page }) => {
    await page.goto(route)
    // 忽略空可访问名的选择复选框列;以首个可见文本表头为业务列顺序契约
    await expect(page.locator('th').filter({ hasText: /./ }).first()).toHaveText('公司')
  })
}
