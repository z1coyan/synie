import type { Actor, Permit } from '../authz/core/index.ts'

/** Hono 请求上下文变量（c.get/c.set 的类型面） */
export type AppEnv = {
  Variables: {
    actor: Actor
    /** 本请求的授权凭证；由 guard(resource, action) 写入，服务层经 permitOf(c) 取 */
    permit?: Permit
    requestId: string
  }
}
