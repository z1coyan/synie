import type { Actor, ScopeAtom, ScopeSet } from './core/index.ts'
import {
  SCOPE_ALL,
  SCOPE_COLUMN_VALUES,
  SCOPE_NONE,
  scopeSetOf,
  scopeSetUnion,
  type ScopeColumnValue,
} from './core/index.ts'
import type { ActorFacts, AuthzStore } from './store.ts'

/** 授权范围列值 → 范围原子；未知值 fail-closed 丢弃（granted 第一期不实现） */
export function scopeAtomFromColumn(value: string): ScopeAtom | null {
  const atom = SCOPE_COLUMN_VALUES[value as ScopeColumnValue] as ScopeAtom | undefined
  if (atom === undefined || atom === 'granted') return null
  return atom
}

export interface ActorAssemblerDeps {
  store: AuthzStore
  /**
   * 全部权限码（sealed registry 派生）：`sys_role.grants_all` 展开的基准。
   * 惰性求值——Registry 在启动期 seal 之后才可读。
   */
  allPermissionCodes: () => readonly string[]
  /** Actor 缓存 TTL（毫秒）；缺省 30s（接受角色变更最长 30s 延迟） */
  ttlMs?: number
  /** 测试注入时钟 */
  now?: () => number
}

/** 事实 → Actor（纯函数，便于单测；grants_all 在此展开为全目录 all 范围） */
export function actorFromFacts(facts: ActorFacts, allPermissionCodes: readonly string[]): Actor {
  const grants = new Map<string, ScopeSet>()
  if (facts.grantsAll) {
    for (const code of allPermissionCodes) grants.set(code, SCOPE_ALL)
  }
  for (const grant of facts.grants) {
    const atom = scopeAtomFromColumn(grant.scope)
    if (atom === null) continue
    grants.set(
      grant.permission,
      scopeSetUnion(grants.get(grant.permission) ?? SCOPE_NONE, scopeSetOf(atom)),
    )
  }
  return {
    kind: 'user',
    userId: facts.userId,
    username: facts.username,
    name: facts.name,
    superAdmin: facts.superAdmin,
    companies: { all: facts.allCompanies, ids: facts.companyIds },
    deptId: facts.deptId,
    deptSubtreeIds: facts.deptSubtreeIds,
    grants,
  }
}

/**
 * Actor 装配（含短 TTL 缓存）。
 * 现按 TTL 收敛；角色/授权写入的主动失效见 spec §13 跟进项（invalidate 已就位）。
 */
export function createActorAssembler(deps: ActorAssemblerDeps) {
  const ttlMs = deps.ttlMs ?? 30_000
  const now = deps.now ?? (() => Date.now())
  const cache = new Map<string, { actor: Actor | null; expiresAt: number }>()

  async function buildActor(userId: string): Promise<Actor | null> {
    const hit = cache.get(userId)
    if (hit && hit.expiresAt > now()) return hit.actor
    const facts = await deps.store.factsByUserId(userId)
    const actor = facts ? actorFromFacts(facts, deps.allPermissionCodes()) : null
    cache.set(userId, { actor, expiresAt: now() + ttlMs })
    return actor
  }

  /** 主动失效；不传 userId 清空全部 */
  function invalidate(userId?: string): void {
    if (userId === undefined) cache.clear()
    else cache.delete(userId)
  }

  return { buildActor, invalidate }
}

export type ActorAssembler = ReturnType<typeof createActorAssembler>
