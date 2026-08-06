/**
 * 菜单白名单过滤派生（纯函数）。
 *
 * 语义（ADR docs/系统架构/adr/2026-08-01-role-menu-whitelist.md）：
 * - 空集合 = 未启用限制 = 原样返回（零行为变化，直接返回入参引用）
 * - 非空集合 = 白名单：只保留命中的叶子菜单项；组内全空则组消失；模块全空则模块消失
 * - 模块默认跳转页（entry）重算为裁剪后首个可见项路径，避免点模块图标落进被隐藏的页面
 *
 * 只配叶子：组/模块没有独立 code，可见性全部由子项派生。
 */
import type { MenuModule } from './menu'

export function filterMenuModules(
  modules: MenuModule[],
  menuCodes: readonly string[],
): MenuModule[] {
  if (menuCodes.length === 0) return modules
  const allowed = new Set(menuCodes)
  const visible: MenuModule[] = []
  for (const m of modules) {
    const groups = m.groups
      .map((g) => ({ ...g, items: g.items.filter((it) => allowed.has(it.code)) }))
      .filter((g) => g.items.length > 0)
    if (groups.length === 0) continue
    const first = groups[0]!.items[0]!
    visible.push({ ...m, groups, entry: first.path })
  }
  return visible
}
