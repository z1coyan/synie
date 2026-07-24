/**
 * 权限端到端浏览器薄冒烟(authz-e2e 工单11)。
 *
 * 验证「前端消费权限」的端到端动线,不承担覆盖率(覆盖率全在 API 矩阵)。
 * setup 已以超管走真实 GraphQL 管理动线建好「演示会计」(建角色→授权→建用户→
 * 指派角色与公司→登录取 token,见 global-setup.ts),本 spec 以该角色断言前端行为。
 *
 * ## 场景与本仓库架构的对齐说明
 *
 * spec 原设想「菜单只含授权模块」——但本前端侧边菜单是**静态数组、不按权限过滤**
 * (`app/lib/menu.ts` + `app/components/app-shell.tsx`,菜单显隐本就不是安全边界,
 * 见 spec.md「前端按钮显隐不是安全边界」)。故前端真正的权限执法面在**页面数据层**
 * (无权资源的表格渲染 forbidden 空态)与**外键列降级**,本冒烟据实断言这两处,
 * 而非菜单过滤。
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { DEMO_STATE_PATH } from './global-setup'
import type { DemoContext } from './helpers/admin-flow'

const TOKEN_KEY = 'synie:token'

// 延迟到 beforeAll 读取:globalSetup 落 demo.json 早于用例运行,但晚于收集期
// (`playwright test --list` 只收集不跑 setup),故不在模块顶层读文件。
let demo: DemoContext

test.beforeAll(() => {
  demo = JSON.parse(readFileSync(DEMO_STATE_PATH, 'utf8')) as DemoContext
})

test.describe.configure({ mode: 'serial' })

test('管理动线 + UI 登录:演示会计凭动线所建账号可登录进工作台', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('用户名').fill(demo.username)
  await page.getByLabel('密码').fill(demo.password)
  await page.getByRole('button', { name: /登\s*录|正在登录/ }).click()

  // 登录成功跳工作台(非 /login);应用外壳的模块导航出现
  await expect(page).toHaveURL(/\/$|\/index/)
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()

  // token 落 localStorage(前端消费权限的凭据)
  const token = await page.evaluate((k) => window.localStorage.getItem(k), TOKEN_KEY)
  expect(token).toBeTruthy()
})

test.describe('凭 token 直达页面(注入 demoToken,免每例走 UI 登录)', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(
      ([k, v]) => window.localStorage.setItem(k, v),
      [TOKEN_KEY, demo.demoToken] as const,
    )
  })

  test('授权页:银行账户可见本司数据(有 acc.bank_account:read + 授权公司)', async ({ page }) => {
    await page.goto('/finance/bank-accounts')

    await expect(page.getByRole('heading', { name: '银行账户' })).toBeVisible()
    // 授权 → 不出 forbidden 空态
    await expect(page.getByText('无权限访问')).toHaveCount(0)
    // 本司数据可见:setup 选定的样本账户别名出现在表格里
    await expect(page.getByText(demo.sampleAlias, { exact: false }).first()).toBeVisible()
  })

  test('跨公司隔离:他司银行账户不出现在列表', async ({ page }) => {
    test.skip(demo.otherCompanyAlias == null, '演示库只有单公司数据,无跨公司对照')
    await page.goto('/finance/bank-accounts')
    await expect(page.getByRole('heading', { name: '银行账户' })).toBeVisible()
    await expect(page.getByText(demo.otherCompanyAlias as string, { exact: true })).toHaveCount(0)
  })

  test('未授权页:直连用户管理 URL 得空态被拒(无 sys.user:read,不重定向)', async ({ page }) => {
    await page.goto('/system/users')

    // 页面照常挂载(前端菜单/路由不设权限守卫),URL 不变——被拒发生在数据层
    await expect(page).toHaveURL(/\/system\/users/)
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
    // 表格取数被后端 forbidden 拒 → 专用空态
    await expect(page.getByText('无权限访问')).toBeVisible()
  })

  test('外键列降级:无 base.company:read → 公司列退为纯文本(非链接)', async ({ page }) => {
    await page.goto('/finance/bank-accounts')
    await expect(page.getByText(demo.sampleAlias, { exact: false }).first()).toBeVisible()

    // 演示会计只有 acc.bank_account:read,gridMeta 会把所有目标资源被裁剪的外键列
    // (公司/币种/科目)降级为纯文本截断 id——样本账户所在行不应出现任何可点外键链接
    const row = page.getByRole('row').filter({ hasText: demo.sampleAlias }).first()
    await expect(row).toBeVisible()
    await expect(row.getByRole('link')).toHaveCount(0)
  })
})
