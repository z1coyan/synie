// 「配置菜单」Sheet 纯逻辑层：叶子码收集、已失效（孤儿）识别、有效勾选数、提交序列化。
// 语义对齐 ADR docs/系统架构/adr/2026-08-01-role-menu-whitelist.md：
// - 只有叶子菜单项参与勾选与提交；组/模块复选框仅是批量快捷（三态由叶子推导）
// - 白名单里存在目录外 code（菜单已删除/改名）= 已失效项：不自动删，提示 + 一键清理
import type { MenuGroup, MenuModule } from '~/lib/menu'

export function groupLeafCodes(g: MenuGroup): string[] {
  return g.items.map((it) => it.code)
}

export function moduleLeafCodes(m: MenuModule): string[] {
  return m.groups.flatMap(groupLeafCodes)
}

export function allLeafCodes(modules: MenuModule[]): string[] {
  return modules.flatMap(moduleLeafCodes)
}

/** 勾选集中不在菜单树内的 code（已失效项），字典序 */
export function orphanCodes(checked: ReadonlySet<string>, modules: MenuModule[]): string[] {
  const valid = new Set(allLeafCodes(modules))
  return [...checked].filter((c) => !valid.has(c)).sort()
}

/** 勾选集中命中菜单树的数量（「已限制 N 项」的 N） */
export function effectiveCount(checked: ReadonlySet<string>, modules: MenuModule[]): number {
  const valid = new Set(allLeafCodes(modules))
  return [...checked].filter((c) => valid.has(c)).length
}

/** 提交序列化：勾选集原样排序（只含叶子 + 未清理的失效项；后端再校验目录内码） */
export function serializeChecked(checked: ReadonlySet<string>): string[] {
  return [...checked].sort()
}

/** 一键清理：返回剔除失效项后的新勾选集 */
export function withoutOrphans(checked: ReadonlySet<string>, modules: MenuModule[]): Set<string> {
  const orphans = new Set(orphanCodes(checked, modules))
  return new Set([...checked].filter((c) => !orphans.has(c)))
}
