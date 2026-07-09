// 权限矩阵纯函数层:通配匹配、勾选初态、保存 diff。
// 通配语义与后端 SynieCore.Authz.Permission 对齐:`前缀:*`(资源全部动作)、`域.*`(域全部码)。

export interface CatalogGroup {
  prefix: string // 如 "sys.role"
  actions: string[] // 如 ["create", "read"]
}

export interface GrantedRow {
  id: string
  permission: string // 具体码或通配码
}

export interface MatrixDiff {
  toCreate: string[] // 需新建的具体权限码
  toDestroyIds: string[] // 需删除的 sys_role_permission 行 id
}

/** 展示顺序(动作全集与后端 Permission.default_actions 一致,顺序为前端展示序);catalog 出现的非标动作(工作流码)排尾 */
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

/** 列 = catalog 全部动作并集:规范序在前,非标动作按首现顺序排尾 */
export function actionColumns(catalog: CatalogGroup[]): string[] {
  const seen = [...new Set(catalog.flatMap((g) => g.actions))]
  const canonical = CANONICAL_ACTIONS.filter((a) => seen.includes(a))
  const extra = seen.filter((a) => !CANONICAL_ACTIONS.includes(a))
  return [...canonical, ...extra]
}

// "sales.order:audit" 的候选:自身、"sales.order:*"、"sales.*"(对齐后端 Permission.candidates/1)
function candidates(code: string): string[] {
  const i = code.indexOf(':')
  if (i < 0) return [code]
  const prefix = code.slice(0, i)
  const j = prefix.indexOf('.')
  return j < 0 ? [code, `${prefix}:*`] : [code, `${prefix}:*`, `${prefix.slice(0, j)}.*`]
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
 * 保存 diff:
 * - 精确行:码被取消 → 删;仍勾选 → 保留。
 * - 通配行:展开集全部仍勾选 → 保留;有任一被取消 → 删行,靠 toCreate 补齐其余逐码。
 * - 目录外的陈旧码不渲染也不动(fail-safe)。
 * - toCreate = 勾选集中未被任何保留行覆盖的码。
 */
export function buildDiff(catalog: CatalogGroup[], rows: GrantedRow[], checked: Set<string>): MatrixDiff {
  const catalogCodes = catalog.flatMap((g) => g.actions.map((a) => `${g.prefix}:${a}`))
  const kept = new Set<string>()
  const toDestroyIds: string[] = []

  for (const row of rows) {
    if (row.permission.endsWith('*')) {
      const expansion = catalogCodes.filter((c) => coveredBy(c, new Set([row.permission])))
      if (expansion.every((c) => checked.has(c))) kept.add(row.permission)
      else toDestroyIds.push(row.id)
    } else if (catalogCodes.includes(row.permission)) {
      if (checked.has(row.permission)) kept.add(row.permission)
      else toDestroyIds.push(row.id)
    } else {
      kept.add(row.permission) // 目录外陈旧码:保留不动
    }
  }

  const toCreate = [...checked].filter((c) => !coveredBy(c, kept))
  return { toCreate, toDestroyIds }
}
