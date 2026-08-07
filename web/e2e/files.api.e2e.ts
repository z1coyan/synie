import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginViaUI } from './fixtures/session'

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

const suffix = Date.now().toString(36)
const storageName = `e2e-local-${suffix}`
const storageLabel = `浏览器测试存储-${suffix}`
const filename = `浏览器文件-${suffix}.txt`

test.setTimeout(90_000)

test('存储 Grid/Drawer、multipart 文件与文件详情只使用 Go REST', async ({ page }) => {
  await loginViaUI(page)

  // page.request 与浏览器同 context,自动携带会话 cookie
  const baselineQuery = await page.request.post('/api/v1/system/storages/query', {
    data: {
      limit: 20,
      offset: 0,
      filter: { name: { kind: 'text', op: 'eq', value: 'go-e2e-local' } },
    },
  })
  expect(baselineQuery.ok()).toBeTruthy()
  const baseline = await baselineQuery.json() as { results: Array<{ id: string }> }
  expect(baseline.results).toHaveLength(1)
  const baselineId = baseline.results[0].id

  const graphqlRequests: string[] = []
  const filesRequests: string[] = []
  page.on('request', (req) => {
    const pathname = new URL(req.url()).pathname
    if (pathname === '/graphql') graphqlRequests.push(req.postData() ?? '')
    if (pathname.startsWith('/api/v1/files') || pathname.startsWith('/api/v1/system/storages')) {
      filesRequests.push(`${req.method()} ${pathname}`)
    }
  })

  let storageId: string | undefined
  let fileId: string | undefined
  try {
    await page.goto('/system/storages')
    await expect(page.getByRole('heading', { name: '存储接入' })).toBeVisible()
    await expect(page.getByRole('grid', { name: 'sysStorages 数据表格' })).toBeVisible()
    await page.getByRole('button', { name: '新增', exact: true }).click()

    const drawer = page.getByRole('dialog', { name: '新增存储接入' })
    await expect(drawer).toBeVisible()
    await drawer.getByLabel('接入名').fill(storageName)
    await drawer.getByLabel('显示名').fill(storageLabel)
    await drawer.getByLabel('存储类型').click()
    await page.getByRole('option', { name: '本地磁盘', exact: true }).click()
    await drawer.getByLabel('根目录').fill(`/tmp/${storageName}`)
    await drawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(drawer).toBeHidden()

    const storageSearch = page.getByRole('searchbox', { name: '搜索' })
    await storageSearch.fill(storageName)
    const storageRow = page.getByRole('row').filter({ hasText: storageName })
    await expect(storageRow).toBeVisible()
    // 等搜索/失效刷新落定再开行操作菜单(竞态,helper 内重试兜底)
    await page.waitForLoadState('networkidle')
    // 「设为默认」行动作已命令化:先弹确认框,确认后执行并出 toast
    const confirmSetDefault = page.getByRole('alertdialog', {
      name: '确认设为默认',
    })
    await clickRowActionMenu(page, storageRow, '设为默认', confirmSetDefault)
    await confirmSetDefault
      .getByRole('button', { name: '确认', exact: true })
      .click()
    // 命令化后成功 toast 为统一口径「{动作}成功(N 条)」
    await expect(page.getByText('设为默认成功(1 条)')).toBeVisible()

    const storageQuery = await page.request.post('/api/v1/system/storages/query', {
      data: {
        limit: 20,
        offset: 0,
        filter: { name: { kind: 'text', op: 'eq', value: storageName } },
      },
    })
    const storageBody = await storageQuery.json() as { results: Array<{ id: string; isDefault: boolean }> }
    expect(storageBody.results).toHaveLength(1)
    expect(storageBody.results[0].isDefault).toBe(true)
    storageId = storageBody.results[0].id

    const upload = await page.evaluate(async ({ filename }) => {
      const form = new FormData()
      form.append('file', new File(['浏览器上传字节'], filename, { type: 'text/plain' }))
      // 浏览器内同源 fetch 自动携带会话 cookie
      const response = await fetch('/api/v1/files', {
        method: 'POST',
        body: form,
      })
      return { ok: response.ok, status: response.status, body: await response.json() }
    }, { filename })
    expect(upload.ok, JSON.stringify(upload)).toBe(true)
    fileId = (upload.body as { file: { id: string; storage: string } }).file.id
    expect((upload.body as { file: { storage: string } }).file.storage).toBe(storageName)

    await page.goto('/system/files')
    await expect(page.getByRole('heading', { name: '文件管理' })).toBeVisible()
    await expect(page.getByRole('grid', { name: 'sysFiles 数据表格' })).toBeVisible()
    await page.getByRole('searchbox', { name: '搜索' }).fill(filename)
    const fileRow = page.getByRole('row').filter({ hasText: filename })
    await expect(fileRow).toBeVisible()
    await page.waitForLoadState('networkidle')
    const fileDrawer = page.getByRole('dialog', { name: '文件详情' })
    await clickRowActionMenu(page, fileRow, '查看', fileDrawer)
    await expect(fileDrawer).toContainText(filename)
    await expect(fileDrawer.getByText('业务挂接(0)')).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await fileDrawer.getByRole('button', { name: '下载', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(filename)

    expect(filesRequests).toContain('POST /api/v1/system/storages')
    expect(filesRequests.some((entry) => entry.endsWith('/set-default'))).toBe(true)
    expect(filesRequests).toContain('POST /api/v1/files')
    expect(graphqlRequests).toEqual([])
  } finally {
    if (fileId) {
      await page.request.delete(`/api/v1/files/${fileId}`)
    }
    await page.request.post(`/api/v1/system/storages/${baselineId}/set-default`)
    if (storageId) {
      await page.request.delete(`/api/v1/system/storages/${storageId}`)
    }
  }
})
