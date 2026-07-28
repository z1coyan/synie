import type { ApiErrorCode } from '@synie/shared'
import { api, apiData } from './client'

export interface SessionUser {
  id: string
  username: string
  /** 可空：首用户/部分种子用户未填显示名 */
  name: string | null
}

export interface MeResponse {
  user: SessionUser
  superAdmin: boolean
  allCompanies: boolean
  permissions: string[]
  companyIds: string[]
}

export interface LoginResponse {
  token: string
  expiresAt: string
  user: SessionUser
}

export const login = (username: string, password: string) =>
  apiData<LoginResponse>(api.auth.login.$post({ json: { username, password } }))

export const fetchMe = () => apiData<MeResponse>(api.auth.me.$get())

// 保留 ApiErrorCode 引用，避免 shared 错误码漂移时 session 侧无感知
export type { ApiErrorCode }
