import type { ScopeAtom } from './scope.ts'

/**
 * 行过滤抽象 AST（不含 SQL、不含列名）：
 * 有效行集 = company ∧ (atoms 的并集)。列绑定由 ResourceMeta.authz 声明提供，
 * 取值由 Permit.actor 提供，编译在 db 适配层（compileRowFilter）。
 */
export interface RowFilter {
  /**
   * 公司边界：
   * - `bypass`：不做公司过滤（超管/system/全公司授权，或资源声明 global）
   * - `none`：零授权公司 → 空行集（语义 not_found，不是 forbidden）
   * - `{ ids }`：行的公司 ∈ ids
   *
   * 公司列名与是否可空是**表事实**，内核不持有——由 ResourceMeta.authz 在编译期提供；
   * 声明为 global 的资源根本不受此边界约束（编译器按绑定决定是否施加）。
   */
  company: 'bypass' | 'none' | { ids: readonly string[] }
  /**
   * 行级范围原子（已按格规范化）：至多一个 all/deptTree/dept/self，
   * 外加正交的 granted（第一期 decide 永不产出）。空数组=空行集。
   */
  atoms: readonly ScopeAtom[]
}

/** 全量放行（超管 / system / global 资源） */
export const ROW_FILTER_ALL: RowFilter = { company: 'bypass', atoms: ['all'] }
