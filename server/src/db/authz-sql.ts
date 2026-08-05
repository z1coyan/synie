/**
 * RowFilter AST → SQL（db 适配层，工单 04）。
 *
 * 有效行集 = 公司边界 ∧ 范围原子并集。列绑定来自 ResourceMeta.authz（AuthzTarget），
 * 取值来自 Permit.actor。空行集编译为 `false`——「empty 早退义务」由此消失。
 *
 * 公司边界只对声明了公司列的资源生效：全局资源（`kind: 'global'`）只有码级判定，
 * 零公司授权的用户照样能读币种/单位/用户等全局主数据（spec §5）。
 */
import { sql, type RawBuilder } from 'kysely'
import { ident } from '~/db/ident.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { AuthzBinding, AuthzTarget } from '~/platform/meta/resource-authz.ts'

const TRUE = sql`true`
const FALSE = sql`false`

function col(alias: string, column: string): RawBuilder<unknown> {
  return sql`${ident(alias)}.${ident(column)}`
}

/** 公司边界是否落在该资源上（只有声明了公司列的资源才受约束） */
function companyBoundaryApplies(target: AuthzTarget): boolean {
  return target.root.company !== undefined
}

/**
 * 编译 Permit 的行过滤为 WHERE 片段。
 *
 * @param alias 目标行所在的表别名（列表 source 无别名时传表名）
 */
export function compileRowFilter(
  permit: Permit,
  target: AuthzTarget,
  alias: string,
): RawBuilder<unknown> {
  const { rowFilter } = permit
  if (rowFilter.atoms.length === 0) return FALSE
  const bounded = companyBoundaryApplies(target)
  // 零公司授权：只有公司域资源被清空，全局资源不受影响
  if (rowFilter.company === 'none' && bounded) return FALSE
  const companyOpen = rowFilter.company === 'bypass' || !bounded
  if (companyOpen && rowFilter.atoms.includes('all')) return TRUE

  // via：判定谓词落在宿主行上，经 join 链以 EXISTS 递归收束
  if (target.chain.length > 0) {
    return compileViaChain(permit, target, alias)
  }
  return conjunction(rowFilterParts(permit, target.root, alias))
}

/** 公司谓词 + 范围原子（作用在同一别名上） */
export function rowFilterParts(
  permit: Permit,
  binding: AuthzBinding,
  alias: string,
): RawBuilder<unknown>[] {
  const { rowFilter, actor } = permit
  const parts: RawBuilder<unknown>[] = []

  const companyScope = rowFilter.company
  // 全局资源无公司列：公司边界不适用（码级判定已过）
  if (binding.company) {
    if (companyScope === 'none') {
      parts.push(FALSE)
    } else if (companyScope !== 'bypass') {
      const target = col(alias, binding.company.column)
      const inScope = sql`${target} = ANY(${[...companyScope.ids]}::uuid[])`
      parts.push(binding.company.nullable ? sql`(${target} IS NULL OR ${inScope})` : inScope)
    }
  }

  const scopeParts: RawBuilder<unknown>[] = []
  for (const atom of rowFilter.atoms) {
    switch (atom) {
      case 'all':
        scopeParts.push(TRUE)
        break
      case 'deptTree': {
        if (!binding.dept || actor.deptSubtreeIds.length === 0) {
          scopeParts.push(FALSE)
          break
        }
        scopeParts.push(
          sql`${col(alias, binding.dept.column)} = ANY(${[...actor.deptSubtreeIds]}::uuid[])`,
        )
        break
      }
      case 'dept': {
        if (!binding.dept || actor.deptId === null) {
          scopeParts.push(FALSE)
          break
        }
        scopeParts.push(sql`${col(alias, binding.dept.column)} = ${actor.deptId}::uuid`)
        break
      }
      case 'self': {
        if (!binding.owner) {
          scopeParts.push(FALSE)
          break
        }
        scopeParts.push(sql`${col(alias, binding.owner.column)} = ${actor.userId}::uuid`)
        break
      }
      case 'granted':
        // 第一期不实现：内核永不产出该原子，走到这里说明装配层漏了拒写
        throw new Error('记录级授权（granted）尚未实现：不应出现在 RowFilter 中')
    }
  }
  parts.push(disjunction(scopeParts))
  return parts
}

/**
 * via 链编译：child → … → root，每层一个 EXISTS。
 * 语义 = 「宿主行本身可见」，与直接读宿主完全一致（单实现，无三套语义）。
 */
function compileViaChain(
  permit: Permit,
  target: AuthzTarget,
  alias: string,
): RawBuilder<unknown> {
  let childAlias = alias
  const opens: RawBuilder<unknown>[] = []
  target.chain.forEach((link, index) => {
    const parentAlias = `authz_p${index}`
    opens.push(
      sql`EXISTS (SELECT 1 FROM ${ident(link.parentTable)} AS ${ident(parentAlias)} WHERE ${ident(
        parentAlias,
      )}.id = ${col(childAlias, link.fk)} AND `,
    )
    childAlias = parentAlias
  })
  let expr = conjunction(rowFilterParts(permit, target.root, childAlias))
  for (let i = opens.length - 1; i >= 0; i -= 1) {
    expr = sql`${opens[i]!}${expr})`
  }
  return expr
}

/** AND 折叠（空集为 true）；列表层拼领域条件时共用 */
export function conjunction(parts: RawBuilder<unknown>[]): RawBuilder<unknown> {
  if (parts.length === 0) return TRUE
  if (parts.length === 1) return parts[0]!
  return sql`(${sql.join(parts, sql` AND `)})`
}

function disjunction(parts: RawBuilder<unknown>[]): RawBuilder<unknown> {
  if (parts.length === 0) return FALSE
  if (parts.length === 1) return parts[0]!
  return sql`(${sql.join(parts, sql` OR `)})`
}
