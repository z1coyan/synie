import type { Actor } from './actor.ts'
import { systemActor } from './actor.ts'
import { ROW_FILTER_ALL, type RowFilter } from './row-filter.ts'
import {
  narrowest,
  normalizeAtoms,
  SCOPE_GRANTED,
  topAtom,
  widest,
  type ScopeAtom,
  type ScopeSet,
} from './scope.ts'

/**
 * 码级组合子（封闭三元：one / anyOf / allOf）。
 * 码是完整权限码（`域.资源:动作`），可跨资源——authz 环负责由 meta 解析出码。
 */
export type CodeRequirement =
  | { kind: 'one'; codes: readonly [string] }
  | { kind: 'anyOf'; codes: readonly string[] }
  | { kind: 'allOf'; codes: readonly string[] }

export function one(code: string): CodeRequirement {
  return { kind: 'one', codes: [code] }
}

export function anyOf(codes: readonly string[]): CodeRequirement {
  if (codes.length === 0) throw new Error('anyOf 至少需要一个权限码')
  return { kind: 'anyOf', codes }
}

export function allOf(codes: readonly string[]): CodeRequirement {
  if (codes.length === 0) throw new Error('allOf 至少需要一个权限码')
  return { kind: 'allOf', codes }
}

declare const PERMIT_BRAND: unique symbol

/**
 * 授权凭证：服务层唯一入场券，**只能由本内核签发**（brand 字段在 core 外不可构造）。
 * 携带该次动作允许触达的行集描述；绕过鉴权直调服务在编译期不成立。
 */
export interface Permit {
  readonly [PERMIT_BRAND]: true
  readonly actor: Actor
  /** 资源名（sealed registry 键），仅作凭证身份标记 */
  readonly resource: string
  /** 动作名（ActionMeta.permissionAction），仅作凭证身份标记 */
  readonly action: string
  readonly rowFilter: RowFilter
}

export interface DecisionRequest {
  resource: string
  action: string
  requirement: CodeRequirement
}

/**
 * 判定结果。**唯一的 deny 原因是码不满足**（HTTP forbidden）；
 * 行级不命中一律表现为 permit + 空行集（HTTP not_found，不泄露存在性）。
 */
export type Decision =
  | { outcome: 'deny'; reason: 'code'; missing: readonly string[] }
  | { outcome: 'permit'; permit: Permit }

/** 唯一的 Permit 构造点：brand 是纯类型标记（不 export，故 core 外无法结构化伪造） */
function mintPermit(
  actor: Actor,
  resource: string,
  action: string,
  rowFilter: RowFilter,
): Permit {
  return Object.freeze({
    actor,
    resource,
    action,
    rowFilter: Object.freeze(rowFilter),
  }) as unknown as Permit
}

function permitted(actor: Actor, req: DecisionRequest, rowFilter: RowFilter): Decision {
  return { outcome: 'permit', permit: mintPermit(actor, req.resource, req.action, rowFilter) }
}

function companyBoundary(actor: Actor): RowFilter['company'] {
  if (actor.companies.all) return 'bypass'
  if (actor.companies.ids.length === 0) return 'none'
  return { ids: actor.companies.ids }
}

/**
 * 判定内核（纯函数、零 IO、零表知识）。逻辑固定，未来所有权限需求不改此函数：
 * superAdmin/system → allow(all)；grants 精确查（无通配）；命中 → company ∧ 范围并集。
 */
export function decide(actor: Actor, req: DecisionRequest): Decision {
  if (actor.superAdmin || actor.kind === 'system') {
    return permitted(actor, req, ROW_FILTER_ALL)
  }

  const requireAll = req.requirement.kind === 'allOf'
  // granted 第一期不实现：装配层拒写，内核兜底剥离（decide 永不产出 granted 原子）
  const hits: ScopeSet[] = []
  const missed: string[] = []
  for (const code of req.requirement.codes) {
    const scopes = actor.grants.get(code)
    if (scopes === undefined) missed.push(code)
    else hits.push((scopes & ~SCOPE_GRANTED) as ScopeSet)
  }

  if (requireAll ? missed.length > 0 : hits.length === 0) {
    return {
      outcome: 'deny',
      reason: 'code',
      missing: requireAll ? missed : [...req.requirement.codes],
    }
  }

  // 每个码先在格上取自身最大元（多角色授同码的并集），再按组合子跨码折叠：
  // one/anyOf 取最宽松（并集），allOf 取最严格（保守，跨资源门控不放大行集）。
  const fold = requireAll ? narrowest : widest
  const top = hits
    .map((scopes) => topAtom(scopes))
    .reduce<ScopeAtom | null>((acc, atom, i) => (i === 0 ? atom : fold(acc, atom)), null)

  return permitted(actor, req, {
    company: companyBoundary(actor),
    atoms: normalizeAtoms(top, false),
  })
}

/**
 * 系统主体凭证（调度器/种子/跨模块受信任读）：恒 bypass 公司与行级范围。
 * 取代 null-actor 分支与「受信任读」裸函数约定。
 */
export function systemPermit(resource: string, action: string): Permit {
  return mintPermit(systemActor(), resource, action, ROW_FILTER_ALL)
}
