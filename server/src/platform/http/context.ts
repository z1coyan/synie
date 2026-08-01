import type { Actor } from '../authz/actor.ts'

/** Hono 请求上下文变量（c.get/c.set 的类型面） */
export type AppEnv = {
  Variables: {
    actor: Actor
    requestId: string
  }
}
