/**
 * 菜单 ↔ 权限资源关联契约测试：「权限与菜单」抽屉的注解（MenuItem.relatedPermissions）
 * 与权限目录（sealed registry 派生）必须双向覆盖——
 * 1. 注解里的每个 prefix 必须真实存在于权限目录（防手滑/目录重构后悬空）；
 * 2. 权限目录里每个 prefix 必须被至少一个菜单项注解，或列入下方显式「无菜单」白名单
 *    （防新资源上线后注解漏标，抽屉里变成无法跳转的孤岛）；
 * 3. 同一菜单项的注解不重复。
 * 语义见 ADR docs/系统架构/adr/2026-08-01-role-menu-whitelist.md。
 */
import { describe, expect, test } from 'bun:test'
import { menuModules } from './menu.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'

/**
 * 无菜单归属的权限资源白名单（逐条注明理由）。当前仅从属地址——其余权限资源均有菜单归属
 * （sys.role_permission/sys.role_menu 挂在「角色权限」菜单下，sys.setting 挂在「基础设置」下；
 * acc.ar_ap 挂在「应收应付」菜单下，阅读仍注解 acc.gl_entry）。
 * 将来出现真正无界面的权限资源时在此补一行并写明原因，勿为消红而放宽断言。
 */
export const UNLINKED_PERMISSION_PREFIXES: ReadonlyArray<string> = [
  // 从属地址无独立菜单：嵌客户/供应商/公司抽屉维护（见 basPartyAddresses classification）
  'base.party_address',
]

const catalogPrefixes = new Set(
  createSealedResourceRegistry()
    .permissionCatalog()
    .map((g) => g.prefix),
)

describe('菜单 ↔ 权限资源关联契约（menu.ts relatedPermissions ↔ 权限目录）', () => {
  test('注解内无重复 prefix，且每个 prefix 都存在于权限目录（差异逐个点名）', () => {
    for (const m of menuModules) {
      for (const g of m.groups) {
        for (const it of g.items) {
          const seen = new Set<string>()
          for (const p of it.relatedPermissions) {
            expect(seen.has(p), `${it.label}(${it.code}) 注解重复: ${p}`).toBe(false)
            seen.add(p)
            expect(
              catalogPrefixes.has(p),
              `${it.label}(${it.code}) 注解了权限目录外 prefix: ${p}`,
            ).toBe(true)
          }
        }
      }
    }
  })

  test('权限目录每个 prefix 均被至少一个菜单注解或列入无菜单白名单（差异逐个点名）', () => {
    const annotated = new Set(
      menuModules.flatMap((m) =>
        m.groups.flatMap((g) => g.items.flatMap((it) => it.relatedPermissions)),
      ),
    )
    const unlinked = new Set(UNLINKED_PERMISSION_PREFIXES)
    const uncovered = [...catalogPrefixes].filter((p) => !annotated.has(p) && !unlinked.has(p))
    expect(
      uncovered,
      `以下权限资源无菜单注解、也不在无菜单白名单: ${uncovered.join(', ')}`,
    ).toEqual([])
  })

  test('无菜单白名单自身合法：每条都须真实存在于权限目录', () => {
    for (const p of UNLINKED_PERMISSION_PREFIXES) {
      expect(catalogPrefixes.has(p), `白名单含目录外 prefix: ${p}`).toBe(true)
    }
  })
})
