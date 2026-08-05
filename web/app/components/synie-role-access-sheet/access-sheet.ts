// 「权限与菜单」统一抽屉纯逻辑层：dirty 计算、保存计划、跳转域推导、行锚点。
// 语义见 .scratch/role-access-drawer/spec.md（grill 六问定案）：
// - 两区勾选态各有独立基线，dirty = 当前勾选 ≠ 基线
// - 保存计划只含「dirty 且可写」的区，顺序固定 菜单 → 功能权限（两 sync 幂等无耦合，
//   顺序仅让部分失败的归因可预期）；计划为空时保存钮禁用
import type { DataScope } from '@synie/shared'

/** 两集合逐元相等（dirty = !setsEqual(当前勾选, 基线)） */
export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** 两授权表逐元相等（功能权限区 dirty = !grantsEqual(当前授权, 基线)）：码集相同且 scope 逐一相等 */
export function grantsEqual(a: ReadonlyMap<string, DataScope>, b: ReadonlyMap<string, DataScope>): boolean {
  if (a.size !== b.size) return false
  for (const [code, scope] of a) if (b.get(code) !== scope) return false
  return true
}

export type SaveSection = 'menus' | 'permissions'

export const SECTION_LABELS: Record<SaveSection, string> = {
  menus: '菜单可见性',
  permissions: '功能权限',
}

/** 保存计划：只提交「dirty 且可写」的区，固定顺序 菜单 → 功能权限 */
export function savePlan(input: {
  menusDirty: boolean
  menusWritable: boolean
  permsDirty: boolean
  permsWritable: boolean
}): SaveSection[] {
  const out: SaveSection[] = []
  if (input.menusDirty && input.menusWritable) out.push('menus')
  if (input.permsDirty && input.permsWritable) out.push('permissions')
  return out
}

/** 菜单注解点击跳转：资源 prefix → 权限矩阵左侧域导航的域 key（同 groupByDomain 的首段切分） */
export function domainOfPrefix(prefix: string): string {
  return prefix.split('.')[0]
}

/** 权限矩阵资源行的锚点 id（跳转 scrollIntoView 用；prefix 含点不影响 getElementById） */
export function permRowId(prefix: string): string {
  return `perm-row-${prefix}`
}
