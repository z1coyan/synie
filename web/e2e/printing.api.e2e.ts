import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const suffix = Date.now().toString(36)
const templateName = `浏览器打印模板-${suffix}`
const updatedName = `${templateName}-已更新`
const fixture = path.resolve(import.meta.dirname, 'fixtures/matrix_template.xlsx')

const pgContainer = process.env.SYNIE_PG_CONTAINER ?? 'synie-postgres-1'
const pgDb = process.env.SYNIE_PG_DB ?? 'synie'

function postgres(sql: string): void {
  execFileSync(
    'docker',
    ['exec', pgContainer, 'psql', '-U', 'synie', '-d', pgDb, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { stdio: 'ignore' },
  )
}

/**
 * 行操作菜单动作（闭环重试收敛）：失效刷新的行重渲染会卸载刚开的菜单，
 * 点击也可能落在已卸载的菜单节点上变成 no-op——
 * 「目标未现则 toggle 菜单→点动作→短超时验证目标」循环直到稳定。
 */
async function clickRowActionMenu(
  page: Page,
  row: Locator,
  actionName: string,
  confirm: Locator,
): Promise<void> {
  const item = page.getByRole('menuitem', { name: actionName, exact: true })
  await expect(async () => {
    if (await confirm.isVisible().catch(() => false)) return
    if (!(await item.isVisible().catch(() => false))) {
      await row.getByRole('button', { name: '行操作' }).click()
    }
    await expect(item).toBeVisible({ timeout: 2_000 })
    await item.click({ timeout: 2_000 })
    await expect(confirm).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

test.setTimeout(90_000)

test('打印模板通过 Grid/Drawer REST 完成且 GraphQL=0', async ({ page }) => {
  await loginViaUI(page)

  const graphqlRequests: string[] = []
  const printingRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname === '/graphql') graphqlRequests.push(request.postData() ?? '')
    if (
      pathname.startsWith('/api/v1/printing') ||
      pathname.startsWith('/api/v1/system/printing') ||
      pathname === '/api/v1/meta/resources/sysPrintTemplates'
    ) {
      printingRequests.push(`${request.method()} ${pathname}`)
    }
  })

  let templateID: string | undefined
  let fileID: string | undefined
  try {
    await page.goto('/system/print-templates')
    await expect(page.getByRole('heading', { name: '打印模板' })).toBeVisible()
    await expect(
      page.getByRole('grid', { name: 'sysPrintTemplates 数据表格' }),
    ).toBeVisible()
    await page.getByRole('button', { name: '新增', exact: true }).click()

    const createDrawer = page.getByRole('dialog', { name: '新增打印模板' })
    await expect(createDrawer).toBeVisible()
    await createDrawer.getByLabel('模板名称').fill(templateName)
    await createDrawer.locator('input[type="file"]').setInputFiles(fixture)
    await expect(createDrawer.getByText('matrix_template.xlsx')).toBeVisible()
    await createDrawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(createDrawer).toBeHidden()

    // page.request 与浏览器同 context,自动携带会话 cookie
    const query = await page.request.post('/api/v1/system/printing/templates/query', {
      data: { limit: 20, offset: 0, search: templateName },
    })
    expect(query.ok()).toBeTruthy()
    const created = (await query.json()) as {
      results: Array<{ id: string; fileId: string }>
    }
    expect(created.results).toHaveLength(1)
    templateID = created.results[0].id
    fileID = created.results[0].fileId

    const search = page.getByRole('searchbox', { name: '搜索' })
    await search.fill(templateName)
    const row = page.getByRole('row').filter({ hasText: templateName })
    await expect(row).toBeVisible()
    // 等搜索/失效刷新落定再开行操作菜单(竞态,helper 内重试兜底)
    await page.waitForLoadState('networkidle')
    // 「设为默认」行动作已命令化:先弹确认框,确认后执行并出 toast
    const confirmSetDefault = page.getByRole('alertdialog', {
      name: '确认设为默认',
    })
    await clickRowActionMenu(page, row, '设为默认', confirmSetDefault)
    await confirmSetDefault
      .getByRole('button', { name: '确认', exact: true })
      .click()
    // 命令化后成功 toast 为统一口径「{动作}成功(N 条)」
    await expect(page.getByText('设为默认成功(1 条)')).toBeVisible()

    await expect(row).toBeVisible()
    const editDrawer = page.getByRole('dialog', { name: '编辑打印模板' })
    await clickRowActionMenu(page, row, '编辑', editDrawer)
    await editDrawer.getByLabel('模板名称').fill(updatedName)
    await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editDrawer).toBeHidden()
    await expect(page.getByRole('row').filter({ hasText: updatedName })).toBeVisible()

    expect(printingRequests).toContain('GET /api/v1/printing/resources')
    expect(printingRequests).toContain('POST /api/v1/system/printing/templates')
    expect(
      printingRequests.some(
        (entry) =>
          entry === `POST /api/v1/system/printing/templates/${templateID}/set-default`,
      ),
    ).toBe(true)
    expect(
      printingRequests.some(
        (entry) => entry === `PATCH /api/v1/system/printing/templates/${templateID}`,
      ),
    ).toBe(true)
    expect(graphqlRequests).toEqual([])
  } finally {
    if (templateID) {
      await page.request.delete(`/api/v1/system/printing/templates/${templateID}`)
    }
    if (fileID) {
      await page.request.delete(`/api/v1/files/${fileID}`)
    }
    const recordIDs = [templateID, fileID].filter(Boolean)
    if (recordIDs.length > 0) {
      postgres(
        `DELETE FROM sys_audit_log WHERE record_id IN (${recordIDs
          .map((id) => `'${id}'::uuid`)
          .join(',')});`,
      )
    }
  }
})
