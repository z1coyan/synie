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

/**
 * OAuth 回调失败时 better-auth 会把 error 以 query 带回（空格变下划线）。
 * 中文业务文案原样展示；机器码映射为可读中文。
 */
const OAUTH_ERROR_LABELS: Record<string, string> = {
  unable_to_create_user: '无法创建登录账号',
  unable_to_create_session: '无法建立登录会话',
  unable_to_link_account: '无法关联登录账号',
  account_not_linked: '该账号尚未关联系统用户',
  signup_disabled: '不允许自动注册，请联系管理员开通账号',
  email_not_found: '身份提供方未返回邮箱',
  email_doesnt_match: '身份提供方邮箱与当前账号不一致',
  invalid_code: '授权码无效或已过期，请重试',
  no_code: '未收到授权码，请重试',
  state_mismatch: '登录状态校验失败，请重试',
  internal_server_error: '登录服务暂时不可用，请稍后再试',
  oauth_provider_not_found: '未配置该身份提供方',
  unable_to_get_user_info: '无法获取身份提供方用户信息',
  no_callback_url: '登录回调配置错误',
  account_already_linked_to_different_user: '该第三方账号已关联其他系统用户',
  invalid_callback_request: '登录回调请求无效',
  UNKNOWN: '登录失败，请重试',
}

/** 将 OAuth `?error=`（及可选 description）转成登录页 toast 文案 */
export function oauthErrorMessage(error: string, description?: string): string {
  const trimmed = error.trim()
  if (!trimmed) return description?.trim() || '请稍后再试'
  // 含中文：多为供给钩子业务拒绝，空格曾被换成下划线时还原
  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed.includes('_') ? trimmed.replaceAll('_', ' ') : trimmed
  }
  return OAUTH_ERROR_LABELS[trimmed] || description?.trim() || '登录失败，请重试'
}
