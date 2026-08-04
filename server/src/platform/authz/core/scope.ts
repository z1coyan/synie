/**
 * 行级范围原子与范围位集（封闭枚举，未来一切权限需求不得新增原子）。
 * 格结构：self ⊆ dept ⊆ deptTree ⊆ all；granted 正交并联（第一期不实现）。
 */

/** 行级范围原子（封闭集，见 ADR 2026-08-04 封闭谓词代数） */
export type ScopeAtom = 'all' | 'deptTree' | 'dept' | 'self' | 'granted'

/** 范围位集：多角色授予同码不同范围时按位或累积 */
export type ScopeSet = number & { readonly __brand?: 'ScopeSet' }

export const SCOPE_NONE = 0 as ScopeSet
export const SCOPE_ALL = 1 as ScopeSet
export const SCOPE_DEPT_TREE = 2 as ScopeSet
export const SCOPE_DEPT = 4 as ScopeSet
export const SCOPE_SELF = 8 as ScopeSet
/** 预留：sys_record_grant 首个消费者出现前，装配层拒写、内核兜底剥离 */
export const SCOPE_GRANTED = 16 as ScopeSet

const BIT: Record<ScopeAtom, ScopeSet> = {
  all: SCOPE_ALL,
  deptTree: SCOPE_DEPT_TREE,
  dept: SCOPE_DEPT,
  self: SCOPE_SELF,
  granted: SCOPE_GRANTED,
}

/** 格上由大到小：并集取首个命中，交集取末个命中 */
const LATTICE: readonly ScopeAtom[] = ['all', 'deptTree', 'dept', 'self']

/** 授权存储的 scope 列取值（`sys_role_permission.scope`）↔ 范围原子 */
export const SCOPE_COLUMN_VALUES = {
  all: 'all',
  dept_tree: 'deptTree',
  dept: 'dept',
  self: 'self',
  granted: 'granted',
} as const satisfies Record<string, ScopeAtom>

export type ScopeColumnValue = keyof typeof SCOPE_COLUMN_VALUES

export function scopeSetOf(...atoms: ScopeAtom[]): ScopeSet {
  let bits = 0
  for (const atom of atoms) bits |= BIT[atom]
  return bits as ScopeSet
}

export function scopeSetUnion(a: ScopeSet, b: ScopeSet): ScopeSet {
  return (a | b) as ScopeSet
}

export function scopeSetIntersect(a: ScopeSet, b: ScopeSet): ScopeSet {
  return (a & b) as ScopeSet
}

export function scopeSetHas(set: ScopeSet, atom: ScopeAtom): boolean {
  return (set & BIT[atom]) !== 0
}

/**
 * 位集 → 格上最大元（最宽松的已授予范围）；空集合返回 null（空行集）。
 * 注意 granted 正交，不参与格比较。
 */
export function topAtom(set: ScopeSet): ScopeAtom | null {
  return LATTICE.find((atom) => scopeSetHas(set, atom)) ?? null
}

/** 格上比较：返回更宽松的一个（用于 one/anyOf 的并集语义） */
export function widest(a: ScopeAtom | null, b: ScopeAtom | null): ScopeAtom | null {
  if (a === null) return b
  if (b === null) return a
  return LATTICE.indexOf(a) <= LATTICE.indexOf(b) ? a : b
}

/**
 * 格上比较：返回更严格的一个（用于 allOf 的保守取值）。
 * 任一侧为空行集（null）则整体为空行集。
 */
export function narrowest(a: ScopeAtom | null, b: ScopeAtom | null): ScopeAtom | null {
  if (a === null || b === null) return null
  return LATTICE.indexOf(a) >= LATTICE.indexOf(b) ? a : b
}

/** 规范化 RowFilter.atoms：至多一个格原子 + 正交 granted */
export function normalizeAtoms(top: ScopeAtom | null, granted: boolean): ScopeAtom[] {
  const atoms: ScopeAtom[] = []
  if (top) atoms.push(top)
  if (granted) atoms.push('granted')
  return atoms
}
