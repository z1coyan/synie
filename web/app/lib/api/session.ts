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
  /** 有效菜单码集合（启用角色白名单并集）；空数组 = 不限制 = 全可见 */
  menuCodes: string[]
}

// 登录/登出走 better-auth cookie 会话(~/lib/auth-client),本模块只剩会话读取
export const fetchMe = () => apiData(api.auth.me.$get())

/**
 * beforeLoad 用 me 查询定义:与组件内 useQuery(['me']) 同 key 共缓存,
 * SSR 取过客户端注水后 30s（默认 staleTime）内不重取;401 不重试,直接裁决登录态
 */
export const meEnsureQuery = {
  queryKey: ['me'] as const,
  queryFn: fetchMe,
  retry: false as const,
}

// 保留 ApiErrorCode 引用，避免 shared 错误码漂移时 session 侧无感知
export type { ApiErrorCode }
