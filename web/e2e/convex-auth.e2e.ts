import { expect, test } from '@playwright/test'
import { waitForHydration } from './helpers/hydration'

const username = process.env.E2E_CONVEX_USERNAME ?? '浏览器管理员'
const password = process.env.E2E_CONVEX_PASSWORD ?? 'Convex-E2E-only-password'

test('Convex 初始化、SSR session、退出与重登闭环', async ({ page, context }) => {
  const retiredBusinessApiPrefix = '/api/' + 'v1'
  const restRequests: string[] = []
  const authResponses: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(retiredBusinessApiPrefix)) {
      restRequests.push(`${request.method()} ${request.url()}`)
    }
  })
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname
    if (path === '/api/auth/sign-in/username' || path === '/api/auth/get-session') {
      const body = await response.json().catch(() => null)
      if (body) authResponses.push(body)
    }
  })

  await page.goto('/setup')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '初始化向导' })).toBeVisible()
  await page.getByLabel('管理员用户名').fill(username)
  await page.getByLabel('姓名（可选）').fill('浏览器验收管理员')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码').fill(password)
  await page.getByRole('button', { name: '创建管理员并继续' }).click()

  await expect(page.getByLabel('公司编号（2 位英文）')).toBeVisible()
  await page.getByLabel('公司编号（2 位英文）').fill('QA')
  await page.getByLabel('公司简称').fill('认证验收')
  await page.getByLabel('公司名称').fill('认证闭环验收公司')
  await expect(page.getByRole('button', { name: '完成初始化' })).toBeEnabled()
  await page.getByRole('button', { name: '完成初始化' }).click()

  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible({
    timeout: 30_000,
  })
  await waitForHydration(page)
  await expect(page.getByText(username, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('synie:' + 'token'))).toBeNull()
  expect(restRequests).toEqual([])

  const sessionCookie = (await context.cookies()).find((cookie) =>
    cookie.name.includes('session_token'),
  )
  expect(sessionCookie).toBeDefined()
  expect(sessionCookie?.httpOnly).toBe(true)
  expect(sessionCookie?.sameSite).toBe('Lax')

  await page.reload()
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible({
    timeout: 30_000,
  })
  await page.goto('/system/users')
  await waitForHydration(page)
  await expect(page).toHaveURL(/\/system\/users$/)
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()

  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('synie:' + 'token'))).toBeNull()

  await page.getByLabel('用户名').fill(username.toUpperCase())
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登 录' }).click()
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible({
    timeout: 30_000,
  })
  expect(await page.evaluate(() => localStorage.getItem('synie:' + 'token'))).toBeNull()
  expect(restRequests).toEqual([])
  expect(JSON.stringify(authResponses)).not.toContain('@internal.syn.ie')
  for (const response of authResponses) {
    if (response && typeof response === 'object' && 'user' in response) {
      expect((response as { user?: object }).user).not.toHaveProperty('email')
    }
  }
})
