/**
 * 测试用 Actor 构造器（仅测试消费；生产路径一律走 createActorAssembler）。
 *
 * 接受两种输入：新体系字段（companies/grants/scopes）与扫荡期存量测试的
 * 旧字段（allCompanies/companyIds/permissions）。旧字段优先，便于存量测试
 * 逐批迁移而不必一次性重写。
 */
import { foldPermissionCode } from './action-compat.ts'
import type { Actor, ScopeAtom, ScopeSet } from './core/index.ts'
import { SCOPE_ALL, SCOPE_NONE, scopeSetOf, scopeSetUnion } from './core/index.ts'

export type TestActorInput = Partial<Actor> & {
  /** @deprecated 旧形状：等价于 companies.all */
  allCompanies?: boolean
  /** @deprecated 旧形状：等价于 companies.ids */
  companyIds?: readonly string[]
  /** @deprecated 旧形状：权限码集合，一律按 all 范围授予 */
  permissions?: Iterable<string>
  /** 精确码 → 范围原子列表（表达行级范围的首选写法） */
  scopes?: Record<string, ScopeAtom[]>
}

export function testActor(input: TestActorInput = {}): Actor {
  const companies =
    input.allCompanies !== undefined || input.companyIds !== undefined
      ? { all: input.allCompanies ?? false, ids: input.companyIds ?? [] }
      : (input.companies ?? { all: false, ids: [] })

  let grants: ReadonlyMap<string, ScopeSet>
  if (input.scopes !== undefined) {
    const map = new Map<string, ScopeSet>()
    for (const [code, atoms] of Object.entries(input.scopes)) {
      const folded = foldPermissionCode(code)
      if (folded === null) continue
      map.set(folded, scopeSetUnion(map.get(folded) ?? SCOPE_NONE, scopeSetOf(...atoms)))
    }
    grants = map
  } else if (input.permissions !== undefined) {
    const map = new Map<string, ScopeSet>()
    for (const code of input.permissions) {
      const folded = foldPermissionCode(code)
      if (folded === null) continue
      map.set(folded, SCOPE_ALL)
    }
    grants = map
  } else {
    grants = input.grants ?? new Map()
  }

  return {
    kind: input.kind ?? 'user',
    userId: input.userId ?? crypto.randomUUID(),
    username: input.username ?? 'test-actor',
    name: input.name ?? null,
    superAdmin: input.superAdmin ?? false,
    companies,
    deptId: input.deptId ?? null,
    deptSubtreeIds: input.deptSubtreeIds ?? [],
    grants,
  }
}
