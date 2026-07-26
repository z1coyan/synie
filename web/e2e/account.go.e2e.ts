import { expect, test } from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const suffix = Date.now().toString(36)
const code = `E2E-${suffix}`
const originalName = `浏览器测试科目-${suffix}`
const updatedName = `浏览器测试科目已更新-${suffix}`

test.setTimeout(90_000)

test('科目树、模板、Drawer 与状态动作只使用 Go REST', async ({ page, request }) => {
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
  const companiesResponse = await request.post('/api/v1/base/companies/query', {
    headers,
    data: { limit: 50, offset: 0, sort: { column: 'code', direction: 'ascending' } },
  })
  expect(companiesResponse.ok()).toBeTruthy()
  const companies = await companiesResponse.json() as { results: Array<{ id: string; name: string }> }
  let company: { id: string; name: string } | undefined
  for (const candidate of companies.results) {
    const response = await request.post('/api/v1/base/accounts/query', {
      headers,
      data: {
        limit: 1,
        offset: 0,
        filter: {
          companyId: { kind: 'fk', op: 'in', values: [candidate.id], labels: [] },
        },
      },
    })
    const body = await response.json() as { count: number }
    if (body.count === 0) {
      company = candidate
      break
    }
  }
  expect(company, '需要一个空公司运行科目模板 E2E').toBeDefined()

  const cleanup = async () => {
    for (let round = 0; round < 5; round++) {
      const response = await request.post('/api/v1/base/accounts/query', {
        headers,
        data: {
          limit: 200,
          offset: 0,
          filter: {
            companyId: { kind: 'fk', op: 'in', values: [company!.id], labels: [] },
          },
        },
      })
      if (!response.ok()) return
      const body = await response.json() as { results: Array<{ id: string; hasChildren: boolean }> }
      if (body.results.length === 0) return
      const leaves = body.results.filter((item) => !item.hasChildren)
      if (leaves.length === 0) return
      for (const item of leaves) {
        await request.delete(`/api/v1/base/accounts/${item.id}`, { headers })
      }
    }
  }

  try {
    const graphqlRequests: Array<{ url: string; body: string | null }> = []
    const accountRequests: string[] = []
    page.on('request', (req) => {
      const pathname = new URL(req.url()).pathname
      if (pathname === '/graphql') {
        graphqlRequests.push({ url: req.url(), body: req.postData() })
      }
      if (pathname.startsWith('/api/v1/base/accounts')) {
        accountRequests.push(`${req.method()} ${pathname}`)
      }
    })

    await page.goto('/base/accounts')
    await expect(page.getByRole('heading', { name: '科目表' })).toBeVisible()
    const companySelector = page.getByRole('group').first()
    await companySelector.click()
    await page.getByRole('option', { name: company!.name, exact: true }).click()
    await expect(page.getByText('该公司还没有科目')).toBeVisible()

    await page.getByRole('button', { name: /科目表模板/ }).click()
    await page.getByRole('option', { name: '国际通用(精简)', exact: true }).click()
    await page.getByRole('button', { name: '从模板初始化', exact: true }).click()
    await expect(page.getByRole('treegrid', { name: 'basAccounts 数据表格' })).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: '资产' })).toBeVisible()

    const assetRow = page.getByRole('row').filter({ hasText: '资产' })
    await assetRow.getByRole('button').first().click()
    await expect(page.getByRole('row').filter({ hasText: '库存现金' })).toBeVisible()

    await page.getByRole('button', { name: '新增', exact: true }).click()
    const createDrawer = page.getByRole('dialog', { name: '新增科目' })
    await expect(createDrawer).toBeVisible()
    await createDrawer.getByLabel('科目编码').fill(code)
    await createDrawer.getByLabel('科目名称').fill(originalName)
    await createDrawer.getByLabel('余额方向').click()
    await page.getByRole('option', { name: '借', exact: true }).click()
    await createDrawer.getByRole('button', { name: '保存', exact: true }).click()
    await expect(createDrawer).toBeHidden()

    const search = page.getByRole('searchbox', { name: '搜索' })
    await search.fill(code)
    let row = page.getByRole('row').filter({ hasText: code })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const editDrawer = page.getByRole('dialog', { name: '编辑科目' })
    await editDrawer.getByLabel('科目名称').fill(updatedName)
    const editResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname.startsWith('/api/v1/base/accounts/'),
    )
    await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
    const editResponse = await editResponsePromise
    const editBody = await editResponse.text()
    expect(editResponse.ok(), String(editResponse.status()) + ' ' + editBody).toBeTruthy()
    await expect(editDrawer).toBeHidden()
    row = page.getByRole('row').filter({ hasText: updatedName })
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '停用', exact: true }).click()
    await expect(page.getByText(`已停用「${updatedName}」`)).toBeVisible()

    expect(accountRequests.some((entry) => entry === 'POST /api/v1/base/accounts/init-template')).toBe(true)
    expect(accountRequests.some((entry) => entry === 'POST /api/v1/base/accounts')).toBe(true)
    expect(accountRequests.some((entry) => entry.startsWith('PATCH /api/v1/base/accounts/'))).toBe(true)
    expect(graphqlRequests).toEqual([])
  } finally {
    await cleanup()
  }
})
