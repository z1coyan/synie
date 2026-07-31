import { expect, test } from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin123'
const suffix = Date.now().toString(36)
const roleCode = `e2e_${suffix}`
const roleName = `浏览器测试角色-${suffix}`

test('角色 Grid/Drawer 使用 Go REST 且不请求 GraphQL', async ({ page, request }) => {
  await page.goto('/login')
  const usernameInput = page.getByRole('textbox', { name: '用户名', exact: true })
  const passwordInput = page.getByRole('textbox', { name: '密码', exact: true })
  await expect.poll(() => usernameInput.evaluate((node) =>
    Object.keys(node).some((key) => key.startsWith('__reactProps$')),
  )).toBe(true)
  await usernameInput.pressSequentially(username)
  await expect(usernameInput).toHaveValue(username)
  await passwordInput.pressSequentially(password)
  await expect(passwordInput).toHaveValue(password)
  const loginButton = page.getByRole('button', { name: /登\s*录|正在登录/ })
  await expect(loginButton).toBeEnabled()
  await loginButton.click()
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()

  await page.goto('/system/roles')
  await expect(page.getByRole('grid', { name: 'sysRoles 数据表格' })).toBeVisible()
  const graphqlRequests: Array<{ url: string; body: string | null }> = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/graphql') {
      graphqlRequests.push({ url: req.url(), body: req.postData() })
    }
  })

  await page.getByRole('button', { name: '新增', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '新增角色' })
  await drawer.getByLabel('角色编码').fill(roleCode)
  await drawer.getByLabel('角色名称').fill(roleName)
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect(drawer).toBeHidden()

  await page.getByRole('searchbox', { name: '搜索' }).fill(roleCode)
  await expect(page.getByRole('row').filter({ hasText: roleCode })).toBeVisible()
  expect(graphqlRequests).toEqual([])

  const token = await page.evaluate(() => window.localStorage.getItem('synie:token'))
  const query = await request.post('/api/v1/system/roles/query', {
    headers: { Authorization: `Bearer ${token}` },
    data: { limit: 10, offset: 0, search: roleCode },
  })
  const queryText = await query.text()
  expect(query.ok(), `${query.status()} ${queryText}`).toBeTruthy()
  const body = JSON.parse(queryText) as { results: Array<{ id: string }> }
  expect(body.results).toHaveLength(1)
  const deleted = await request.delete(`/api/v1/system/roles/${body.results[0].id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(deleted.ok()).toBeTruthy()
  expect(graphqlRequests).toEqual([])
})
