import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { waitForHydration } from './helpers/hydration'

const username = process.env.E2E_CONVEX_USERNAME ?? '资源验收管理员'
const password = process.env.E2E_CONVEX_PASSWORD ?? 'Convex-resource-E2E-only-password'
const repositoryRoot = resolve(import.meta.dirname, '../..')

type SmokeResult = {
  marker: string
  limitedUsername: string
  limitedPassword: string
  companyCode: string
  formalCompanyName: string
}

test('三个 ResourceBinding pilot 在 self-hosted Convex 完成浏览器闭环', async ({ page }) => {
  const retiredBusinessApiPrefix = '/api/' + 'v1'
  const restRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(retiredBusinessApiPrefix)) {
      restRequests.push(`${request.method()} ${request.url()}`)
    }
  })

  await page.goto('/setup')
  await waitForHydration(page)
  await page.getByLabel('管理员用户名').fill(username)
  await page.getByLabel('姓名（可选）').fill('资源验收管理员')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码').fill(password)
  await page.getByRole('button', { name: '创建管理员并继续' }).click()
  await expect(page.getByLabel('公司编号（2 位英文）')).toBeVisible()
  await page.getByLabel('公司编号（2 位英文）').fill('QR')
  await page.getByLabel('公司简称').fill('资源验收')
  await page.getByLabel('公司名称').fill('资源闭环验收公司')
  await expect(page.getByRole('button', { name: '完成初始化' })).toBeEnabled()
  await page.getByRole('button', { name: '完成初始化' }).click()
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()

  const verifier = spawnSync('bun', ['scripts/verify-convex-resources.ts'], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
  })
  const verifierFailure = (verifier.stderr || verifier.stdout || '无输出').slice(-4_000)
  expect(verifier.status, `真实 Convex 资源验证器失败：\n${verifierFailure}`).toBe(0)
  const resultPath = process.env.SYNIE_RESOURCE_RESULT_FILE
  expect(resultPath).toBeTruthy()
  const smoke = JSON.parse(readFileSync(resultPath!, 'utf8')) as SmokeResult

  await page.goto('/base/currencies')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '货币管理' })).toBeVisible()
  await page.getByRole('button', { name: '新增', exact: true }).click()
  await expect(page.getByRole('heading', { name: '新增货币' })).toBeVisible()
  await page.getByLabel('货币名称').fill('浏览器验收币种')
  await page.getByLabel('ISO 编码').fill('UIX')
  await page.getByLabel('符号').fill('U')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('货币已创建')).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索' }).fill('浏览器验收币种')
  await expect(page.getByText('浏览器验收币种', { exact: true })).toBeVisible()
  await page.reload()
  await waitForHydration(page)
  await page.getByRole('searchbox', { name: '搜索' }).fill('浏览器验收币种')
  await expect(page.getByText('浏览器验收币种', { exact: true })).toBeVisible()

  await page.goto('/base/units')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '单位管理' })).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索' }).fill('千克')
  await expect(page.getByText(new RegExp(`千克-${smoke.marker}|公克-${smoke.marker}`)).first()).toBeVisible()

  await page.goto('/scm/warehouses')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '仓库管理' })).toBeVisible()
  await expect(page.getByText(new RegExp(smoke.companyCode)).first()).toBeVisible()
  await page.getByRole('button', { name: '初始化默认仓库' }).click()
  await expect(page.getByText('默认仓库已经存在')).toBeVisible()

  await page.goto('/system/companies')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '公司管理' })).toBeVisible()
  await expect(page.getByText(smoke.formalCompanyName, { exact: true }).first()).toBeVisible()

  await page.goto('/system/users')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()

  await page.goto('/scm/settings/sales')
  await waitForHydration(page)
  await expect(page.getByText('样品订单', { exact: true })).toBeVisible()

  for (const [path, heading] of [
    ['/mfg/process-templates', '工艺模板'],
    ['/mfg/boms', 'BOM'],
    ['/mfg/demands/orders', '需求单'],
    ['/mfg/work-orders', '生产工单'],
    ['/mfg/outputs/outputs', '生产入库'],
  ] as const) {
    await page.goto(path)
    await waitForHydration(page)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }

  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await waitForHydration(page)
  await page.getByLabel('用户名').fill(smoke.limitedUsername)
  await page.getByLabel('密码', { exact: true }).fill(smoke.limitedPassword)
  await page.getByRole('button', { name: '登 录' }).click()
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()

  await page.goto('/base/currencies')
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: '货币管理' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新增', exact: true })).toHaveCount(0)
  await page.goto('/scm/warehouses')
  await waitForHydration(page)
  await expect(page.getByText(new RegExp(smoke.companyCode)).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '初始化默认仓库' })).toHaveCount(0)
  expect(restRequests).toEqual([])
})
