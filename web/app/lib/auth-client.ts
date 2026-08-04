/**
 * better-auth React client：cookie 会话（httpOnly `synie.session_token`）。
 * baseURL 不填 → 浏览器侧取同源 origin，经 Vite 代理/生产反代到 Bun server。
 */
import { createAuthClient } from 'better-auth/react'
import { genericOAuthClient, usernameClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  basePath: '/api/v1/auth',
  plugins: [usernameClient(), genericOAuthClient()],
})

/** 登录失败文案：限流与凭证错误分开，其余透传服务端 message */
export function signInErrorMessage(error: {
  status: number
  message?: string
}): string {
  if (error.status === 429) return '登录尝试过于频繁,请稍后再试'
  if (error.status === 401) return '用户名或密码错误'
  return error.message || '请稍后再试'
}
