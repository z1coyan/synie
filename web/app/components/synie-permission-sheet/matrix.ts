// 权限矩阵纯函数层：勾选初态、三态、搜索过滤、sync 提交集构造。
// 授权为 (role, code, scope) 三元组（spec §3）：通配符已取消，授权行恒为精确码；
// scope 取 DataScope 名（all/deptTree/self；存量 leftover dept 可读可再保存），
// 只在资源 supportedScopes 内可新授。
import type { DataScope } from '@synie/shared'

export interface CatalogGroup {
  prefix: string // 如 "sys.role"
  label?: string // 后端下发的资源中文名;缺失时前端回落 permission-labels 静态映射
  actions: string[] // 如 ["create", "read"]
  /** 该资源支持的数据范围（目录 wire 携带）；空或仅 all 时不渲染范围控件 */
  supportedScopes: DataScope[]
}

export interface GrantedRow {
  id: string
  permission: string // 精确码
  scope: DataScope
}

export type TriState = 'all' | 'some' | 'none'

/** 矩阵固定列：封闭八动作（查看/新增/编辑/审核/删除/作废/导出/打印） */
export const CANONICAL_ACTIONS = [
  'read',
  'create',
  'update',
  'audit',
  'delete',
  'void',
  'export',
  'print',
]

/** 数据范围标签。dept 仅存量 leftover 展示，目录不再开放新授。 */
export const SCOPE_LABELS: Record<DataScope, string> = {
  all: '全部',
  deptTree: '本部门及以下',
  dept: '本部门（存量）',
  self: '仅本人',
}

const ADVERTISED_SCOPES: readonly DataScope[] = ['all', 'deptTree', 'self']

/**
 * 该资源的范围选项（目录可新授的档；不含 leftover dept）；
 * supportedScopes 为空或仅 all 时返回 null——调用方据此不渲染范围控件。
 */
export function scopeOptionsOf(group: CatalogGroup): DataScope[] | null {
  const options = group.supportedScopes.filter((s) => ADVERTISED_SCOPES.includes(s))
  if (!options.includes('all')) options.unshift('all')
  return options.length > 1 ? options : null
}

/**
 * 某条已授行的范围选项：目录档 + 若当前是 leftover dept 且资源支持 deptTree，则保留 dept 以便回读/再保存。
 */
export function scopeOptionsForGrant(group: CatalogGroup, current?: DataScope): DataScope[] | null {
  const base = scopeOptionsOf(group)
  if (current === 'dept' && group.supportedScopes.includes('deptTree')) {
    const opts = [...(base ?? ['all'])]
    if (!opts.includes('dept')) opts.push('dept')
    return opts
  }
  return base
}

/** 按 prefix 首段分域,保持 catalog 原有顺序 */
export function groupByDomain(catalog: CatalogGroup[]): { domain: string; groups: CatalogGroup[] }[] {
  const out: { domain: string; groups: CatalogGroup[] }[] = []
  for (const g of catalog) {
    const domain = g.prefix.split('.')[0]
    const bucket = out.find((b) => b.domain === domain)
    if (bucket) bucket.groups.push(g)
    else out.push({ domain, groups: [g] })
  }
  return out
}

/** 资源的全部动作码(固定列 + "更多"里的),保持 actions 原顺序 */
export function groupCodes(g: CatalogGroup): string[] {
  return g.actions.map((a) => `${g.prefix}:${a}`)
}

/** 把资源的动作拆成固定列动作(规范序) + "更多"动作(原序) */
export function splitActions(actions: string[]): { fixed: string[]; extra: string[] } {
  return {
    fixed: CANONICAL_ACTIONS.filter((a) => actions.includes(a)),
    extra: actions.filter((a) => !CANONICAL_ACTIONS.includes(a)),
  }
}

/** 搜索过滤:按展示标签或 prefix 子串匹配(大小写不敏感),保持 catalog 原顺序 */
export function searchGroups(
  catalog: CatalogGroup[],
  keyword: string,
  labelOf: (g: CatalogGroup) => string
): CatalogGroup[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return []
  return catalog.filter((g) => labelOf(g).toLowerCase().includes(kw) || g.prefix.toLowerCase().includes(kw))
}

/** 三态:codes 全勾/部分勾/全未勾;空集按未勾(调用方据此禁用该全选框)。checked 只需能回答 has(code)（Set 与 Map 均可） */
export function triState(codes: string[], checked: { has(code: string): boolean }): TriState {
  const n = codes.filter((c) => checked.has(c)).length
  return n === 0 ? 'none' : n === codes.length ? 'all' : 'some'
}

/** 勾选初态:目录内精确码 → scope（Map）；目录外码不收（后端 sync 也保留不动,前端不展示） */
export function initialGrants(catalog: CatalogGroup[], rows: GrantedRow[]): Map<string, DataScope> {
  const inCatalog = new Set(catalog.flatMap(groupCodes))
  const grants = new Map<string, DataScope>()
  for (const row of rows) {
    if (inCatalog.has(row.permission)) grants.set(row.permission, row.scope)
  }
  return grants
}

function submitScope(group: CatalogGroup, scope: DataScope): DataScope {
  if (scope === 'dept' && group.supportedScopes.includes('deptTree')) return 'dept'
  return group.supportedScopes.includes(scope) ? scope : 'all'
}

/**
 * sync 提交集:勾选码按 catalog 序展开为 { permission, scope }[]。
 * leftover dept 在资源支持 deptTree 时原样保留，不钳成 all。
 * 其余越界范围钳回 all。目录外码不进提交集。
 */
export function buildSubmit(
  catalog: CatalogGroup[],
  grants: Map<string, DataScope>,
): { permission: string; scope: DataScope }[] {
  return catalog.flatMap((g) =>
    groupCodes(g)
      .filter((code) => grants.has(code))
      .map((code) => ({
        permission: code,
        scope: submitScope(g, grants.get(code)!),
      })),
  )
}
