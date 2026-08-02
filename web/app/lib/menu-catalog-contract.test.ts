/**
 * 前后端菜单目录契约测试：前端静态菜单声明（渲染事实源）与后端菜单目录
 * （白名单 sync 校验基准）必须对齐——任一侧增删菜单项/改 code 而另一侧未跟，
 * 本测试即红并报出差异清单。
 */
import { describe, expect, test } from 'bun:test'
import { menuModules } from './menu.ts'
import { MENU_CODE_PATTERN, allMenuCodes, menuCatalog } from '~/platform/menu/catalog.ts'

function frontendLeafCodes(): string[] {
  return menuModules.flatMap((m) => m.groups.flatMap((g) => g.items.map((it) => it.code)))
}

/** 命名约定推导：`menu.<模块 key>.<路径末段>`，'/' 末段取 home。 */
function expectedCode(moduleKey: string, path: string): string {
  const seg = path === '/' ? 'home' : path.split('/').filter(Boolean).pop()!
  return `menu.${moduleKey}.${seg}`
}

describe('菜单目录契约（前端 menu.ts ↔ 后端 menu catalog）', () => {
  test('前端每个菜单项 code 符合命名约定且全局唯一', () => {
    const seen = new Map<string, string>()
    for (const m of menuModules) {
      for (const g of m.groups) {
        for (const it of g.items) {
          expect(it.code, `${it.label} 的 code 应等于约定推导值`).toBe(expectedCode(m.key, it.path))
          expect(it.code).toMatch(MENU_CODE_PATTERN)
          const dup = seen.get(it.code)
          expect(dup, `code ${it.code} 重复（${dup} 与 ${m.key}/${it.label}）`).toBeUndefined()
          seen.set(it.code, `${m.key}/${it.label}`)
        }
      }
    }
  })

  test('两侧模块 key 集合一致', () => {
    const frontendKeys = menuModules.map((m) => m.key).sort()
    const backendKeys = menuCatalog.map((m) => m.key).sort()
    expect(backendKeys).toEqual(frontendKeys)
  })

  test('两侧叶子 code 集合互等（差异逐个点名）', () => {
    const frontend = new Set(frontendLeafCodes())
    const backend = new Set(allMenuCodes())
    const missingInBackend = [...frontend].filter((c) => !backend.has(c))
    const missingInFrontend = [...backend].filter((c) => !frontend.has(c))
    expect(missingInBackend, `后端目录缺失: ${missingInBackend.join(', ')}`).toEqual([])
    expect(missingInFrontend, `前端菜单缺失: ${missingInFrontend.join(', ')}`).toEqual([])
  })

  test('后端目录标签非空', () => {
    for (const m of menuCatalog) {
      expect(m.label.length).toBeGreaterThan(0)
      for (const g of m.groups) {
        for (const it of g.items) {
          expect(it.label.length, `${it.code} 标签为空`).toBeGreaterThan(0)
        }
      }
    }
  })
})
