// 权限矩阵纯函数层：勾选初态、三态、搜索过滤、sync 提交集构造。
// 授权为 (role, code, scope) 三元组（spec §3）：通配符已取消，授权行恒为精确码；
// scope 取 DataScope 名（all/deptTree/dept/self），只在资源 supportedScopes 内可授。
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

/** 矩阵固定列(默认动作集,与后端 Permission.default_actions 一致,顺序为前端展示序);其余动作(工作流码)收进行尾"更多" */
export const CANONICAL_ACTIONS = [
  'create', 'read', 'update', 'delete', 'print', 'import',
  'export', 'batch_delete', 'batch_update', 'batch_print',
]

/** 数据范围标签（封闭集，与 DataScope 一一对应；granted 第一期不开放） */
export const SCOPE_LABELS: Record<DataScope, string> = {
  all: '全部',
  deptTree: '本部门及以下',
  dept: '本部门',
  self: '仅本人',
}

/**
 * 该资源的范围选项（按 supportedScopes 过滤，恒含 all）；
 * supportedScopes 为空或仅 all 时返回 null——调用方据此不渲染范围控件（恒 all 无选择空间）。
 */
export function scopeOptionsOf(group: CatalogGroup): DataScope[] | null {
  const options = group.supportedScopes.filter((s) => s in SCOPE_LABELS)
  if (!options.includes('all')) options.unshift('all')
  return options.length > 1 ? options : null
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

/**
 * sync 提交集:勾选码按 catalog 序展开为 { permission, scope }[]（与勾选插入顺序无关,快照可比对）。
 * scope 必须在该组 supportedScopes 内——不在则钳回 'all'（fail-safe：
 * 服务端 assertGrantable 会拒授目录不支持的范围,前端先兜住不产出必败请求）。
 * flatMap catalog 构造天然不含目录外码。
 */
export function buildSubmit(
  catalog: CatalogGroup[],
  grants: Map<string, DataScope>,
): { permission: string; scope: DataScope }[] {
  return catalog.flatMap((g) =>
    groupCodes(g)
      .filter((code) => grants.has(code))
      .map((code) => {
        const scope = grants.get(code)!
        return { permission: code, scope: g.supportedScopes.includes(scope) ? scope : 'all' }
      }),
  )
}
