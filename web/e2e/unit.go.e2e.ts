import { expect, test } from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const suffix = Date.now().toString(36)
const symbol = `e2e-${suffix}`
const name = `浏览器测试单位-${suffix}`

test('单位 Grid 与 Drawer CRUD 不经过 GraphQL', async ({ page, request }) => {
  await page.goto('/login')
  const usernameInput = page.getByRole('textbox', { name: '用户名', exact: true })
  const passwordInput = page.getByRole('textbox', { name: '密码', exact: true })
  await expect.poll(() => usernameInput.evaluate((node) =>
    Object.keys(node).some((key) => key.startsWith('__reactProps$')),
  )).toBe(true)
  await usernameInput.pressSequentially(username)
  await passwordInput.pressSequentially(password)
  await page.getByRole('button', { name: /登\s*录|正在登录/ }).click()
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()

  const graphqlRequests: Array<{ url: string; body: string | null }> = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/graphql') {
      graphqlRequests.push({ url: req.url(), body: req.postData() })
    }
  })

  await page.goto('/base/units')
  await expect(page.getByRole('heading', { name: '单位管理' })).toBeVisible()
  await expect(page.getByRole('grid', { name: 'basUnits 数据表格' })).toBeVisible()
  await page.getByRole('button', { name: '新增', exact: true }).click()

  const drawer = page.getByRole('dialog', { name: '新增单位' })
  await expect(drawer).toBeVisible()
  await drawer.getByLabel('单位类型').click()
  await page.getByRole('option', { name: '数量', exact: true }).click()
  await drawer.getByLabel('单位名称').fill(name)
  await drawer.getByLabel('单位符号').fill(symbol)
  await drawer.getByLabel('换算比例').fill('1')
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect(drawer).toBeHidden()

  await page.getByRole('searchbox', { name: '搜索' }).fill(symbol)
  await expect(page.getByRole('row').filter({ hasText: symbol })).toBeVisible()
  expect(graphqlRequests).toEqual([])

  const token = await page.evaluate(() => window.localStorage.getItem('synie:token'))
  const query = await request.post('/api/v1/base/units/query', {
    headers: { Authorization: `Bearer ${token}` },
    data: { limit: 10, offset: 0, search: symbol },
  })
  const queryBody = await query.text()
  expect(query.ok(), `${query.status()} ${queryBody}`).toBeTruthy()
  const body = JSON.parse(queryBody) as { results: Array<{ id: string }> }
  expect(body.results).toHaveLength(1)
  const deleted = await request.delete(`/api/v1/base/units/${body.results[0].id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(deleted.ok()).toBeTruthy()
  expect(graphqlRequests).toEqual([])
})
