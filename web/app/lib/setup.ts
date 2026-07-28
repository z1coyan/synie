import type { ApiErrorBody } from '@synie/shared'
import { getToken } from './auth'
import { APIError, apiData } from './api/client'
import { AppError } from './errors'

export interface SetupStatus {
  initialized: boolean
  hasUsers: boolean
}

export interface SetupFirstUserInput {
  username: string
  password: string
  name?: string | null
}

export type SetupLanguage = 'zh-CN' | 'en-US'

export interface SetupFirstUserResult {
  token: string
  expiresAt: string
  user: { id: string; username: string; name: string }
}

// 完成旗标落库后永不回退:true 可永久缓存,省得每次路由切换都重查;
// false 不缓存——向导完成初始化后的首次检查必须看到最新值
let initializedCache: SetupStatus | null = null

/**
 * Setup 路由由工单 16 挂到 ApiType；在此之前用同源 fetch 打 /api/v1/setup/*，
 * 错误 envelope 与 hc 路径一致（APIError + fields）。
 */
async function setupFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`/api/v1/setup${path}`, { ...init, headers })
  return apiData<T>(Promise.resolve(response))
}

/** 初始化向导状态(未认证可查);路由门控与向导页共用 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  if (initializedCache) return initializedCache
  const status = await setupFetch<SetupStatus>('/status')
  if (status.initialized) initializedCache = status
  return status
}

/** 创建首个超级管理员并取得登录态(仅未初始化且没有用户时可用) */
export function createSetupFirstUser(input: SetupFirstUserInput) {
  return setupFetch<SetupFirstUserResult>('/first-user', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** 幂等预置初始化向导使用的常用货币 */
export function seedSetupCommonCurrencies() {
  return setupFetch<unknown>('/currencies/seed-common', { method: 'POST', body: '{}' })
}

/** 仅启用选定本位币，其余预置币保持停用 */
export function activateSetupBaseCurrency(currencyId: string) {
  return setupFetch<unknown>('/currencies/activate-base', {
    method: 'POST',
    body: JSON.stringify({ currencyId }),
  })
}

/** 写入用户语言与基础种子，最后落初始化完成旗标 */
export function completeSetup(preferredLanguage: SetupLanguage, seedSampleData = false) {
  return setupFetch<unknown>('/complete', {
    method: 'POST',
    body: JSON.stringify({ preferredLanguage, seedSampleData }),
  })
}

// 避免未使用导入被 tree-shake 误删（APIError 供调用方 catch 窄化）
export type { APIError, AppError, ApiErrorBody }
