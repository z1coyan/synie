import { expect, test } from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin123'
const suffix = Date.now().toString(36)
const storageName = `e2e-local-${suffix}`
const storageLabel = `浏览器测试存储-${suffix}`
const filename = `浏览器文件-${suffix}.txt`

test.setTimeout(90_000)

test('存储 Grid/Drawer、multipart 文件与文件详情只使用 Go REST', async ({ page, request }) => {
  await page.goto('/login')
  const usernameInput = page.getByRole('textbox', { name: '用户名', exact: true })
  const passwordInput = page.getByRole('textbox', { name: '密码', exact: true })
  await expect.poll(() => usernameInput.evaluate((node) =>
    Object.keys(node).some((key) => key.startsWith('__reactProps$')),
  )).toBe(true)
  await usernameInput.pressSequentially(username)
  await passwordInput.pressSequentially(password)
  await page.getByRole('button', { name: /登\s*录|正在登录/ }).click()
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()

  const token = await page.evaluate(() => window.localStorage.getItem('synie:token'))
  const headers = { Authorization: `Bearer ${token}` }
  const baselineQuery = await request.post('/api/v1/system/storages/query', {
    headers,
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
    await storageRow.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '设为默认', exact: true }).click()
    await expect(page.getByText(`已将「${storageLabel}」设为默认存储`)).toBeVisible()

    const storageQuery = await request.post('/api/v1/system/storages/query', {
      headers,
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
      const response = await fetch('/api/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${window.localStorage.getItem('synie:token')}` },
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
    await fileRow.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '查看', exact: true }).click()
    const fileDrawer = page.getByRole('dialog', { name: '文件详情' })
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
      await request.delete(`/api/v1/files/${fileId}`, { headers })
    }
    await request.post(`/api/v1/system/storages/${baselineId}/set-default`, { headers })
    if (storageId) {
      await request.delete(`/api/v1/system/storages/${storageId}`, { headers })
    }
  }
})
