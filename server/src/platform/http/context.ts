import type { RequestAuthMethod } from '../auth/api-key.ts'
import type { Actor, Permit } from '../authz/core/index.ts'

/** Hono 请求上下文变量（c.get/c.set 的类型面） */
export type AppEnv = {
  Variables: {
    actor: Actor
    /** 本请求的授权凭证；由 guard(resource, action) 写入，服务层经 permitOf(c) 取 */
    permit?: Permit
    /** 本次认证走的凭证种类；不进 Actor（authz 内核零凭证知识） */
    authMethod?: RequestAuthMethod
    requestId: string
  }
}
