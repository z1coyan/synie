/**
 * e2e 会话 helper：UI 登录建立 better-auth cookie 会话（httpOnly `synie.session_token`），
 * 取代旧「localStorage 抠 JWT + Authorization: Bearer」模式。
 * - 同 context 的 `page.request` 与浏览器内 fetch 自动携带 cookie，无需显式头
 * - 直连 API origin（绕开前端代理）的 node fetch 用 `sessionCookieHeader` 显式组 Cookie 头
 */
import { expect, type BrowserContext, type Page } from '@playwright/test'

export const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin'
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin123'

/** UI 登录进工作台；成功后会话 cookie 已落在 page 所属 context */
export async function loginViaUI(
  page: Page,
  creds: { username?: string; password?: string } = {},
): Promise<void> {
  await page.goto('/login')
  const usernameInput = page.getByRole('textbox', { name: '用户名', exact: true })
  const passwordInput = page.getByRole('textbox', { name: '密码', exact: true })
  // HeroUI 受控输入要等 React 挂载完才吃得进 pressSequentially
  await expect
    .poll(() =>
      usernameInput.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith('__reactProps$')),
      ),
    )
    .toBe(true)
  await usernameInput.pressSequentially(creds.username ?? ADMIN_USERNAME)
  await passwordInput.pressSequentially(creds.password ?? ADMIN_PASSWORD)
  // 锚定整词：登录页可能另有「使用 Logto 登录」按钮（logtoEnabled 时渲染）
  await page.getByRole('button', { name: /^(登\s*录|正在登录)$/ }).click()
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()
  // 会话 cookie 已落（httpOnly，页面 JS 不可见，从 context 断言）
  const cookies = await page.context().cookies()
  expect(cookies.some((c) => c.name === 'synie.session_token')).toBe(true)
}

/**
 * 从 context 取会话 cookie 组显式 Cookie 头。
 * 仅用于直连 API origin 的 node fetch（cookie 域是前端 origin，跨 origin 不会自动带）；
 * 返回纯字符串头，context 关闭后仍可用于 afterAll 清理。
 */
export async function sessionCookieHeader(
  context: BrowserContext,
): Promise<{ Cookie: string }> {
  const cookies = (await context.cookies()).filter((c) => c.name.startsWith('synie.'))
  expect(cookies.length).toBeGreaterThan(0)
  return { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') }
}
