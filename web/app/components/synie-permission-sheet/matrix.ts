// 权限矩阵纯函数层:通配匹配、勾选初态、三态、搜索过滤、sync 提交集构造。
// 通配语义与后端 SynieCore.Authz.Permission 对齐:`前缀:*`(资源全部动作)、`域.*`(域全部码)、`*`(全域)。

export interface CatalogGroup {
  prefix: string // 如 "sys.role"
  label?: string // 后端下发的资源中文名;缺失时前端回落 permission-labels 静态映射
  actions: string[] // 如 ["create", "read"]
}

export interface GrantedRow {
  id: string
  permission: string // 具体码或通配码
}

export type TriState = 'all' | 'some' | 'none'

/** 矩阵固定列(默认动作集,与后端 Permission.default_actions 一致,顺序为前端展示序);其余动作(工作流码)收进行尾"更多" */
export const CANONICAL_ACTIONS = [
  'create', 'read', 'update', 'delete', 'print', 'import',
  'export', 'batch_delete', 'batch_update', 'batch_print',
]

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

/** 三态:codes 全勾/部分勾/全未勾;空集按未勾(调用方据此禁用该全选框) */
export function triState(codes: string[], checked: Set<string>): TriState {
  const n = codes.filter((c) => checked.has(c)).length
  return n === 0 ? 'none' : n === codes.length ? 'all' : 'some'
}

// "sales.order:audit" 的候选:自身、"sales.order:*"、"sales.*"、"*"(对齐后端 Permission.candidates/1)
function candidates(code: string): string[] {
  const i = code.indexOf(':')
  if (i < 0) return [code, '*']
  const prefix = code.slice(0, i)
  const j = prefix.indexOf('.')
  return j < 0 ? [code, `${prefix}:*`, '*'] : [code, `${prefix}:*`, `${prefix.slice(0, j)}.*`, '*']
}

/** granted(具体码或通配码集合)是否覆盖给定具体码 */
export function coveredBy(code: string, granted: Set<string>): boolean {
  return candidates(code).some((c) => granted.has(c))
}

/** 勾选初态:catalog 每个码,granted 行有精确码或通配覆盖即勾上 */
export function initialChecked(catalog: CatalogGroup[], rows: GrantedRow[]): Set<string> {
  const granted = new Set(rows.map((r) => r.permission))
  const checked = new Set<string>()
  for (const g of catalog) {
    for (const a of g.actions) {
      const code = `${g.prefix}:${a}`
      if (coveredBy(code, granted)) checked.add(code)
    }
  }
  return checked
}

/**
 * syncSysRolePermissions 提交集:当前勾选的具体码,按 catalog 序,剔除两类——
 * - 被任一存量通配行覆盖的码:通配行后端保留,若再提交会被重复落成具体行;
 * - 初态/勾选本只含 catalog 码,此处 flatMap catalog 构造天然不含目录外码(fail-safe)。
 * 语义注意:取消勾选通配覆盖的码不会生效(通配行仍在,后端保留),与"通配行与目录外码后端保留"契约一致。
 */
export function buildSubmit(catalog: CatalogGroup[], rows: GrantedRow[], checked: Set<string>): string[] {
  const wildcards = new Set(rows.map((r) => r.permission).filter((p) => p.endsWith('*')))
  return catalog.flatMap(groupCodes).filter((c) => checked.has(c) && !coveredBy(c, wildcards))
}
