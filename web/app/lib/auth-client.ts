import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { usernameClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * 浏览器永远走 TanStack Start 的同源 `/api/auth/*`；这里不得配置 Convex Site URL，
 * 否则 cookie 会绕过应用 origin。
 */
export const authClient = createAuthClient({
  plugins: [usernameClient(), convexClient()],
})

export function signInErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const status = 'status' in error ? error.status : undefined
    const statusCode = 'statusCode' in error ? error.statusCode : undefined
    if (status === 429 || statusCode === 429) {
      return '登录尝试过于频繁,请稍后再试'
    }
  }
  // 不透传 Better Auth 的具体用户/凭证错误，避免账号枚举。
  return '用户名或密码错误'
}
