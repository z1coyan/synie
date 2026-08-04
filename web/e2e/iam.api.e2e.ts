import { expect, test } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const suffix = Date.now().toString(36)
const roleCode = `e2e_${suffix}`
const roleName = `浏览器测试角色-${suffix}`

test('角色 Grid/Drawer 使用 Go REST 且不请求 GraphQL', async ({ page }) => {
  await loginViaUI(page)

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

  // page.request 与浏览器同 context,自动携带会话 cookie
  const query = await page.request.post('/api/v1/system/roles/query', {
    data: { limit: 10, offset: 0, search: roleCode },
  })
  const queryText = await query.text()
  expect(query.ok(), `${query.status()} ${queryText}`).toBeTruthy()
  const body = JSON.parse(queryText) as { results: Array<{ id: string }> }
  expect(body.results).toHaveLength(1)
  const deleted = await page.request.delete(`/api/v1/system/roles/${body.results[0].id}`)
  expect(deleted.ok()).toBeTruthy()
  expect(graphqlRequests).toEqual([])
})
