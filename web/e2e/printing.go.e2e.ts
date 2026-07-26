import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const suffix = Date.now().toString(36)
const templateName = `浏览器打印模板-${suffix}`
const updatedName = `${templateName}-已更新`
const fixture = path.resolve(
  '../backend/apps/synie_web/test/support/fixtures/matrix_template.xlsx',
)

function postgres(sql: string): void {
  execFileSync(
    'docker',
    ['exec', 'synie-postgres-1', 'psql', '-U', 'synie', '-d', 'synie', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { stdio: 'ignore' },
  )
}

test.setTimeout(90_000)

test('打印模板通过 Grid/Drawer REST 完成且 GraphQL=0', async ({ page, request }) => {
  await page.goto('/login')
  const usernameInput = page.getByRole('textbox', { name: '用户名', exact: true })
  const passwordInput = page.getByRole('textbox', { name: '密码', exact: true })
  await expect
    .poll(() =>
      usernameInput.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith('__reactProps$')),
      ),
    )
    .toBe(true)
  await usernameInput.pressSequentially(username)
  await passwordInput.pressSequentially(password)
  await page.getByRole('button', { name: /登\s*录|正在登录/ }).click()
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()

  const token = await page.evaluate(() => window.localStorage.getItem('synie:token'))
  const headers = { Authorization: `Bearer ${token}` }
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

    const query = await request.post('/api/v1/system/printing/templates/query', {
      headers,
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
    await row.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '设为默认', exact: true }).click()
    await expect(page.getByText(`已将「${templateName}」设为默认`)).toBeVisible()

    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑打印模板' })
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
      await request.delete(`/api/v1/system/printing/templates/${templateID}`, { headers })
    }
    if (fileID) {
      await request.delete(`/api/v1/files/${fileID}`, { headers })
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
