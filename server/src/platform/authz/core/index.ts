/**
 * platform/authz/core：判定内核（纯函数、零 IO、零表知识）。
 *
 * 三环边界（ADR 2026-08-04 Permit 凭证式鉴权）：
 *   core（本目录）→ platform/authz（授权存储 + Actor 装配 + guard）
 *   → db/http 适配层（RowFilter → SQL、guard 挂路由）
 *
 * 本目录不得 import 任何 db / http / meta 模块。
 */
export type { Actor } from './actor.ts'
export { SYSTEM_USER_ID, systemActor } from './actor.ts'
export type { CodeRequirement, Decision, DecisionRequest, Permit } from './decide.ts'
export { allOf, anyOf, decide, one, systemPermit } from './decide.ts'
export type { RowFilter } from './row-filter.ts'
export { ROW_FILTER_ALL } from './row-filter.ts'
export type { ScopeAtom, ScopeColumnValue, ScopeSet } from './scope.ts'
export {
  SCOPE_ALL,
  SCOPE_COLUMN_VALUES,
  SCOPE_DEPT,
  SCOPE_DEPT_TREE,
  SCOPE_GRANTED,
  SCOPE_NONE,
  SCOPE_SELF,
  narrowest,
  normalizeAtoms,
  scopeSetHas,
  scopeSetIntersect,
  scopeSetOf,
  scopeSetUnion,
  topAtom,
  widest,
} from './scope.ts'
