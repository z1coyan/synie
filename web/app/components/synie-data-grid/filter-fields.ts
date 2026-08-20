import type { FilterState, GridColumnMeta } from './types'

/** 列 override 里与筛选入口相关的字段（filterField 代理 + 展示标签） */
export type FilterFieldOverride = {
  filterField?: string
  label?: string
}

/**
 * 可见列对应的筛选目标：filterField 代理改按同行另一字段（如物料列 → materialId），
 * 标签沿用列标签；无代理则列本身须 filterable。
 */
export function filterTargetOf(
  col: GridColumnMeta,
  overrides: Record<string, FilterFieldOverride | undefined>,
  allColumns: GridColumnMeta[],
): GridColumnMeta | null {
  const proxy = overrides[col.name]?.filterField
  if (proxy == null) return col.filterable ? col : null
  const target = allColumns.find((c) => c.name === proxy)
  return target?.filterable ? { ...target, label: overrides[col.name]?.label ?? col.label } : null
}

/** 可见列上的可筛字段（含 filterField 代理），按目标字段名去重，顺序随可见列。 */
export function filterableFields(
  visibleColumns: GridColumnMeta[],
  overrides: Record<string, FilterFieldOverride | undefined>,
  allColumns: GridColumnMeta[],
): GridColumnMeta[] {
  const seen = new Set<string>()
  const out: GridColumnMeta[] = []
  for (const col of visibleColumns) {
    const target = filterTargetOf(col, overrides, allColumns)
    if (!target || seen.has(target.name)) continue
    seen.add(target.name)
    out.push(target)
  }
  return out
}

/** 加法器候选：可筛且当前未生效的字段。 */
export function adderFields(fields: GridColumnMeta[], filters: FilterState): GridColumnMeta[] {
  return fields.filter((c) => filters[c.name] === undefined)
}

/**
 * 已生效筛选的展示列：优先可见列（含代理标签，如 materialId →「物料」），
 * 否则回退 meta 全量列（URL / defaultFilters / 隐藏列上的预置条件）。
 */
export function resolveFilterColumn(
  name: string,
  visibleColumns: GridColumnMeta[],
  overrides: Record<string, FilterFieldOverride | undefined>,
  allColumns: GridColumnMeta[],
): GridColumnMeta | undefined {
  const fromVisible = filterableFields(visibleColumns, overrides, allColumns).find((c) => c.name === name)
  if (fromVisible) return fromVisible
  return allColumns.find((c) => c.name === name)
}
