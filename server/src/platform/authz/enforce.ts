/**
 * 执行面入口（工单 04）：把判定内核接到 HTTP 链上。
 *
 * 路由统一挂 `guard(resource, action)`：
 *   查 sealed registry 确认 (resource, action) 存在 → 解析 via 链到宿主 → decide → Permit 入 ctx。
 * 错误语义唯一规则：码不满足 = forbidden；行级不命中 = not_found（由 loadAuthorized / 列表空集落地）。
 */
import type { MiddlewareHandler } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import type { Registry } from '../meta/registry.ts'
import type { AuthzTarget } from '../meta/resource-authz.ts'
import {
  allOf,
  anyOf,
  decide,
  one,
  type Actor,
  type CodeRequirement,
  type Decision,
  type Permit,
} from './core/index.ts'

/**
 * 动作码要求覆盖：跨资源门控（allOf）与多码可读（anyOf）。
 * 两者不应同时给出；同时给出时 `anyOf` 优先（它是完整覆盖，allOf 是叠加）。
 */
export interface GuardOptions {
  /** 附加要求：本资源动作码之外还必须全部满足的完整码（跨资源 allOf 门控） */
  allOf?: readonly string[]
  /** 覆盖为任一命中即通过的完整码集合（import-as-read 等重载） */
  anyOf?: readonly string[]
}

export interface AuthzEnforcer {
  /** Hono 中间件：判定通过则把 Permit 放进 ctx */
  guard: (resource: string, action: string, options?: GuardOptions) => MiddlewareHandler<AppEnv>
  /** 分支内二次取凭证（如导入分支需 hr.employee:create）；不经中间件 */
  permitFor: (c: Context<AppEnv>, resource: string, action: string, options?: GuardOptions) => Permit
  /** 纯判定（不抛错），供投影与测试消费 */
  decideFor: (actor: Actor, resource: string, action: string, options?: GuardOptions) => Decision
  /** 已解析的判定归宿（列绑定 + via join 链），SQL 编译层消费 */
  targetOf: (resource: string) => AuthzTarget
}

export function createAuthzEnforcer(registry: Registry): AuthzEnforcer {
  /** 解析与记忆化都归 Registry（服务层的 listAuthorized/loadAuthorized 用同一份） */
  function targetOf(resource: string): AuthzTarget {
    return registry.authzTarget(resource)
  }

  /** 动作必须在 sealed registry 的归宿资源上存在（杜绝客户端提供 prefix 的路径） */
  function assertActionDeclared(target: AuthzTarget, action: string): void {
    // 声明了 readAnyOf 的资源没有自己的 read 码（只读投影/导入重载），码由声明给出
    if (action === 'read' && target.readAnyOf.length > 0) return
    const root = registry.get(target.rootResource)!
    const declared = root.actions.some((a) => (a.permissionAction ?? a.key) === action)
    if (!declared) {
      throw new Error(
        `资源 ${target.resource}（判定归宿 ${target.rootResource}）未声明动作 ${action}：动作码唯一事实源是 meta`,
      )
    }
  }

  function requirementFor(
    target: AuthzTarget,
    action: string,
    options?: GuardOptions,
  ): CodeRequirement {
    if (options?.anyOf && options.anyOf.length > 0) return anyOf(options.anyOf)
    const own = `${target.prefix}:${action}`
    // 跨资源门控：本资源动作码 + 附加码全部满足（范围取格上最小，保守）
    if (options?.allOf && options.allOf.length > 0) return allOf([own, ...options.allOf])
    // read 的码级组合子由 meta 声明（取代 readPermissionsAny，声明即执行）
    if (action === 'read' && target.readAnyOf.length > 0) return anyOf(target.readAnyOf)
    return one(own)
  }

  function decideFor(
    actor: Actor,
    resource: string,
    action: string,
    options?: GuardOptions,
  ): Decision {
    const target = targetOf(resource)
    assertActionDeclared(target, action)
    return decide(actor, {
      resource,
      action,
      requirement: requirementFor(target, action, options),
    })
  }

  function permitFor(
    c: Context<AppEnv>,
    resource: string,
    action: string,
    options?: GuardOptions,
  ): Permit {
    const actor = c.get('actor')
    if (!actor) {
      // guard 必须挂在 requireAuth 之后；没身份是 401 不是 500
      throw new ApiError('unauthorized', '未登录或登录状态已失效')
    }
    const decision = decideFor(actor, resource, action, options)
    if (decision.outcome === 'deny') {
      throw new ApiError('forbidden', '无权限执行该操作')
    }
    return decision.permit
  }

  function guard(
    resource: string,
    action: string,
    options?: GuardOptions,
  ): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
      c.set('permit', permitFor(c, resource, action, options))
      await next()
    }
  }

  return { guard, permitFor, decideFor, targetOf }
}

/** 取本请求的 Permit；未经 guard 即抛（fail-closed，不静默放行） */
export function permitOf(c: Context<AppEnv>): Permit {
  const permit = c.get('permit')
  if (!permit) {
    throw new Error('本路由未挂 guard(resource, action)：服务层需要 Permit 凭证')
  }
  return permit
}
