/**
 * 授权声明的注册期/seal 校验与目录投影（工单 03）。
 *
 * 事实源是 `ResourceMeta.authz`：register 时缺失即抛错（对齐 classification 先例），
 * seal 时校验声明列存在、`via.parent` 在目录内、global 资源确无公司列。
 * 本文件只做声明校验与派生，不执行判定（执行面见 platform/authz + db/http 适配层）。
 */
import type { ScopeAtom } from '../authz/core/index.ts'
import type { ResourceAuthz, ResourceMeta } from './types.ts'

export const DEFAULT_COMPANY_COLUMN = 'company_id'
export const DEFAULT_OWNER_COLUMN = 'created_by_id'
export const DEFAULT_STAMPED_DEPT_COLUMN = 'owner_dept_id'

/** 已解析的授权绑定（列名已定，供 SQL 编译与盖章消费） */
export interface AuthzBinding {
  resource: string
  kind: ResourceAuthz['kind']
  /** company 形态才有 */
  company?: { column: string; nullable: boolean }
  /** via 形态才有 */
  via?: { parent: string; fk: string }
  owner?: { column: string }
  dept?: { column: string; mode: 'stamped' | 'assigned' }
  /** read 的码级组合子；空数组表示走缺省 one(prefix:read) */
  readAnyOf: readonly string[]
}

/** 取声明；缺失即报错并点名资源（register/seal/执行面共用一处文案） */
function requireAuthz(meta: ResourceMeta): ResourceAuthz {
  if (!meta.authz) {
    throw new Error(
      `Meta 资源「${meta.name}」缺少 authz 声明（company / global / via 必须有意识选择）`,
    )
  }
  return meta.authz
}

export function resolveAuthzBinding(meta: ResourceMeta): AuthzBinding {
  const authz = requireAuthz(meta)
  const binding: AuthzBinding = {
    resource: meta.name,
    kind: authz.kind,
    readAnyOf: authz.readAnyOf ?? [],
  }
  if (authz.kind === 'company') {
    binding.company = {
      column: authz.companyColumn ?? DEFAULT_COMPANY_COLUMN,
      nullable: authz.nullable ?? false,
    }
  }
  if (authz.kind === 'via') {
    binding.via = { parent: authz.parent, fk: authz.fk }
    return binding
  }
  if (authz.owner) {
    binding.owner = { column: authz.owner.column ?? DEFAULT_OWNER_COLUMN }
  }
  if (authz.dept) {
    // assigned 形态必须显式声明列（注册期已校验）；stamped 缺省 owner_dept_id
    binding.dept = {
      column: authz.dept.column ?? DEFAULT_STAMPED_DEPT_COLUMN,
      mode: authz.dept.mode,
    }
  }
  return binding
}

/** 注册期校验（不依赖其他资源）：形态自洽、预留项拒绝 */
export function assertValidAuthzDeclaration(meta: ResourceMeta): void {
  const authz = requireAuthz(meta)
  if (authz.kind !== 'via' && authz.recordGrants) {
    throw new Error(
      `Meta 资源「${meta.name}」声明了 recordGrants：记录级授权第一期不实现（见 spec §9）`,
    )
  }
  if (authz.kind === 'via') {
    if (!authz.parent || !authz.fk) {
      throw new Error(`Meta 资源「${meta.name}」的 via 声明必须同时给出 parent 与 fk`)
    }
    return
  }
  if (authz.dept && authz.dept.mode === 'assigned' && !authz.dept.column) {
    throw new Error(`Meta 资源「${meta.name}」的 assigned 部门形态必须显式声明业务列`)
  }
}

/**
 * seal 期跨资源校验：绑定列存在于 fields、via.parent 在目录内、
 * global 资源确无公司列（防漏声明）、readAnyOf 码在目录内。
 */
export function assertAuthzClosure(
  meta: ResourceMeta,
  ctx: { hasResource: (name: string) => boolean; allCodes: ReadonlySet<string> },
): void {
  const authz = requireAuthz(meta)
  const columns = new Set(meta.fields.map((f) => f.dbColumn))
  const requireColumn = (column: string, what: string): void => {
    if (!columns.has(column)) {
      throw new Error(`Meta 资源「${meta.name}」authz ${what} 声明的列 ${column} 不在 fields 中`)
    }
  }

  for (const code of authz.readAnyOf ?? []) {
    if (!ctx.allCodes.has(code)) {
      throw new Error(`Meta 资源「${meta.name}」authz.readAnyOf 含目录外权限码: ${code}`)
    }
  }

  if (authz.kind === 'via') {
    if (!ctx.hasResource(authz.parent)) {
      throw new Error(`Meta 资源「${meta.name}」authz.via.parent 引用未知资源: ${authz.parent}`)
    }
    requireColumn(authz.fk, 'via.fk')
    return
  }

  const binding = resolveAuthzBinding(meta)
  if (authz.kind === 'company') {
    requireColumn(binding.company!.column, 'company')
  } else if (columns.has(DEFAULT_COMPANY_COLUMN)) {
    throw new Error(
      `Meta 资源「${meta.name}」声明为 global 但存在 ${DEFAULT_COMPANY_COLUMN} 列：应声明 company（漏声明防呆）`,
    )
  }
  if (binding.owner) requireColumn(binding.owner.column, 'owner')
  if (binding.dept) requireColumn(binding.dept.column, 'dept')
}

/**
 * 判定归宿：via 链解析到宿主根，并带回 child → parent 的 join 链。
 * 「派生资源判定递归到宿主资源自己的 decide()」在此落地。
 */
export interface AuthzTarget {
  /** 请求的资源名 */
  resource: string
  /** 判定归宿资源名（via 链根；非 via 时即自身） */
  rootResource: string
  /** 归宿的权限前缀（码级判定基准） */
  prefix: string
  /** 归宿的绑定（公司列/owner/dept） */
  root: AuthzBinding
  /** read 的码级组合子（取请求资源的声明，未声明时回落归宿声明） */
  readAnyOf: readonly string[]
  /** 由请求资源到归宿的 join 链（child→parent 顺序）；非 via 时为空 */
  chain: readonly { childTable: string; fk: string; parentTable: string }[]
}

const MAX_VIA_DEPTH = 8

export function resolveAuthzTarget(
  resource: string,
  lookup: (name: string) => ResourceMeta | undefined,
): AuthzTarget {
  const requested = lookup(resource)
  if (!requested) throw new Error(`未知资源: ${resource}`)
  const chain: { childTable: string; fk: string; parentTable: string }[] = []
  let current = requested
  for (let depth = 0; ; depth += 1) {
    if (depth > MAX_VIA_DEPTH) {
      throw new Error(`资源 ${resource} 的 via 链过深或成环`)
    }
    const authz = requireAuthz(current)
    if (authz.kind !== 'via') break
    const parent = lookup(authz.parent)
    if (!parent) throw new Error(`Meta 资源「${current.name}」的 via.parent 未注册: ${authz.parent}`)
    chain.push({ childTable: current.table, fk: authz.fk, parentTable: parent.table })
    current = parent
  }
  return {
    resource,
    rootResource: current.name,
    prefix: current.permissionPrefix,
    root: resolveAuthzBinding(current),
    readAnyOf: requireAuthz(requested).readAnyOf ?? requireAuthz(current).readAnyOf ?? [],
    chain,
  }
}

/**
 * 资源支持的数据范围（目录投影基准）：
 * company 恒为外层边界不入此集；无 owner 声明则无 self，无 dept 声明则无 dept/deptTree。
 * via 资源不拥有自己的范围（判定递归宿主），返回空集。
 */
export function supportedScopesOf(meta: ResourceMeta): ScopeAtom[] {
  const authz = meta.authz
  if (!authz || authz.kind === 'via') return []
  const scopes: ScopeAtom[] = ['all']
  if (authz.dept) scopes.push('deptTree', 'dept')
  if (authz.owner) scopes.push('self')
  return scopes
}
