import { api, apiData } from './api/client'

export interface SetupStatus {
  initialized: boolean
  hasUsers: boolean
  /** Logto OIDC 是否启用（服务端 env 门控）；登录页据此显示 Logto 按钮 */
  logtoEnabled: boolean
}

export interface SetupFirstUserInput {
  username: string
  password: string
  name?: string | null
}

export type SetupLanguage = 'zh-CN' | 'en-US'

// 完成旗标落库后永不回退:true 可缓存,省得每次路由切换都重查;
// false 不缓存——向导完成初始化后的首次检查必须看到最新值。
// 缓存仅限浏览器端:vite dev / SSR 服务进程长存且模块单例跨请求共享,
// 服务端缓存 true 会让 db:reset 后 /setup 永远 307 回工作台(2026-08-08 事故)
let initializedCache: SetupStatus | null = null

/** 初始化向导状态(未认证可查);路由门控与向导页共用 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const isBrowser = typeof window !== 'undefined'
  if (isBrowser && initializedCache) return initializedCache
  const status = await apiData(api.setup.status.$get())
  if (isBrowser && status.initialized) initializedCache = status
  return status
}

/**
 * beforeLoad 用 setupStatus 查询定义:与页面内 useQuery(['setupStatus']) 同 key 共缓存。
 * 调用方失败时一律 fail-open(不据此弹 /setup),避免与向导互弹死循环
 */
export const setupStatusEnsureQuery = {
  queryKey: ['setupStatus'] as const,
  queryFn: fetchSetupStatus,
  retry: false as const,
}

/** 创建首个超级管理员并取得登录态(仅未初始化且没有用户时可用) */
export function createSetupFirstUser(input: SetupFirstUserInput) {
  return apiData(
    api.setup['first-user'].$post({ json: input as never }),
  )
}

/** 幂等预置初始化向导使用的常用货币 */
export function seedSetupCommonCurrencies() {
  return apiData(api.setup.currencies['seed-common'].$post())
}

/** 仅启用选定本位币，其余预置币保持停用 */
export function activateSetupBaseCurrency(currencyId: string) {
  return apiData(
    api.setup.currencies['activate-base'].$post({
      json: { currencyId },
    }),
  )
}

/** 写入用户语言与基础种子，最后落初始化完成旗标 */
export function completeSetup(preferredLanguage: SetupLanguage, seedSampleData = false) {
  return apiData(
    api.setup.complete.$post({
      json: { preferredLanguage, seedSampleData },
    }),
  )
}
