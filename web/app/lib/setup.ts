import { gqlFetch } from './graphql'

export interface SetupStatus {
  initialized: boolean
  hasUsers: boolean
}

const SETUP_STATUS_QUERY = `
  query {
    setupStatus { initialized hasUsers }
  }
`

// 完成旗标落库后永不回退:true 可永久缓存,省得每次路由切换都重查;
// false 不缓存——向导完成初始化后的首次检查必须看到最新值
let initializedCache: SetupStatus | null = null

/** 初始化向导状态(未认证可查);路由门控与向导页共用 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  if (initializedCache) return initializedCache
  const data = await gqlFetch<{ setupStatus: SetupStatus }>(SETUP_STATUS_QUERY)
  if (data.setupStatus.initialized) initializedCache = data.setupStatus
  return data.setupStatus
}
