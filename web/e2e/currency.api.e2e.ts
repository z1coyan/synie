import { expect, test } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const sequence = Date.now() % (alphabet.length * alphabet.length)
const isoCode = `Q${alphabet[Math.floor(sequence / alphabet.length)]}${alphabet[sequence % alphabet.length]}`
const name = `浏览器测试币种-${isoCode}`

test('Go 登录与币种 CRUD 不经过 GraphQL', async ({ page }) => {
  await loginViaUI(page)

  await page.goto('/base/currencies')
  await expect(page.getByRole('heading', { name: '货币管理' })).toBeVisible()
  await expect(page.getByRole('grid', { name: 'basCurrencies 数据表格' })).toBeVisible()

  const graphqlRequests: Array<{ url: string; body: string | null }> = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/graphql') {
      graphqlRequests.push({ url: req.url(), body: req.postData() })
    }
  })

  await page.getByRole('button', { name: '新增', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '新增货币' })
  await drawer.getByLabel('货币名称').fill(name)
  await drawer.getByLabel('ISO 编码').fill(isoCode)
  await drawer.getByLabel('符号').fill('¤')
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect(drawer).toBeHidden()

  await page.getByRole('searchbox', { name: '搜索' }).fill(isoCode)
  await expect(page.getByRole('row').filter({ hasText: isoCode })).toBeVisible()
  expect(graphqlRequests).toEqual([])

  // 用同一 REST API 清理测试数据；删除本身也必须没有 GraphQL 请求。
  // page.request 与浏览器同 context,自动携带会话 cookie
  const query = await page.request.post('/api/v1/base/currencies/query', {
    data: { limit: 10, offset: 0, search: isoCode },
  })
  const queryBody = await query.text()
  expect(query.ok(), `${query.status()} ${queryBody}`).toBeTruthy()
  const body = JSON.parse(queryBody) as { results: Array<{ id: string }> }
  expect(body.results).toHaveLength(1)
  const deleted = await page.request.delete(`/api/v1/base/currencies/${body.results[0].id}`)
  expect(deleted.ok()).toBeTruthy()
  expect(graphqlRequests).toEqual([])
})
