import { apiClient, apiData } from './api/client'

export interface SetupStatus {
  initialized: boolean
  hasUsers: boolean
}

// 完成旗标落库后永不回退:true 可永久缓存,省得每次路由切换都重查;
// false 不缓存——向导完成初始化后的首次检查必须看到最新值
let initializedCache: SetupStatus | null = null

/** 初始化向导状态(未认证可查);路由门控与向导页共用 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  if (initializedCache) return initializedCache
  const status = await apiData(apiClient.GET('/setup/status'))
  if (status.initialized) initializedCache = status
  return status
}
