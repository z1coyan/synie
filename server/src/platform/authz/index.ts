/**
 * platform/authz：授权存储 + Actor 装配 + 对外判定入口。
 *
 * 三环边界（ADR 2026-08-04）：core 纯判定 → 本环拥有存储与装配 → db/http 适配执行。
 * 部门树是 IAM 的组织主数据，本环只消费「用户 → 部门子树」窄接口。
 */
export type { Actor, CodeRequirement, Decision, Permit, RowFilter, ScopeAtom, ScopeSet } from './core/index.ts'
export {
  ROW_FILTER_ALL,
  SCOPE_ALL,
  SCOPE_COLUMN_VALUES,
  SCOPE_DEPT,
  SCOPE_DEPT_TREE,
  SCOPE_GRANTED,
  SCOPE_NONE,
  SCOPE_SELF,
  SYSTEM_USER_ID,
  allOf,
  anyOf,
  decide,
  one,
  scopeSetOf,
  systemActor,
  systemPermit,
} from './core/index.ts'
export type { ActorAssembler } from './build-actor.ts'
export { actorFromFacts, createActorAssembler, scopeAtomFromColumn } from './build-actor.ts'
export type { ActorFacts, AuthzStore } from './store.ts'
export { createAuthzStore } from './store.ts'
