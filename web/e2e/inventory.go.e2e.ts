import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password =
  process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const goAPIURL = process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const suffix = Date.now().toString(36).toUpperCase()
const categoryCode = `E2E_INV_${suffix}`
const categoryName = `浏览器库存分类-${suffix}`

async function login(page: Page): Promise<string> {
  await page.goto('/login')
  const usernameInput = page.getByRole('textbox', {
    name: '用户名',
    exact: true,
  })
  const passwordInput = page.getByRole('textbox', {
    name: '密码',
    exact: true,
  })
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
  const token = await page.evaluate(() =>
    window.localStorage.getItem('synie:token'),
  )
  expect(token).toBeTruthy()
  return token!
}

async function expectOK(
  responsePromise: Promise<import('@playwright/test').Response>,
) {
  const response = await responsePromise
  const text = await response.text()
  expect(
    response.ok(),
    `${response.request().method()} ${response.url()}: ${response.status()} ${text}`,
  ).toBeTruthy()
  return text === '' ? null : (JSON.parse(text) as Record<string, unknown>)
}

function postgres(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      'synie-postgres-1',
      'psql',
      '-U',
      'synie',
      '-d',
      'synie',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim()
}

async function cleanupCategory(token: string, id: string): Promise<void> {
  const response = await fetch(
    `${goAPIURL}/inventory/material-categories/${id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `cleanup material category: ${response.status} ${await response.text()}`,
    )
  }
}

test.setTimeout(180_000)

test('库存主数据、流水、余额与三类单据页面全程使用 Go REST', async ({
  page,
}) => {
  const token = await login(page)
  const graphqlRequests: Array<{ url: string; body: string | null }> = []
  const restRequests: string[] = []
  let categoryID: string | null = null

  page.on('request', (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname
    if (pathname === '/graphql') {
      graphqlRequests.push({ url: outgoing.url(), body: outgoing.postData() })
    }
    if (
      pathname.startsWith('/api/v1/inventory/') ||
      pathname.startsWith('/api/v1/meta/resources/inv') ||
      pathname === '/api/v1/auth/me'
    ) {
      restRequests.push(`${outgoing.method()} ${pathname}`)
    }
  })

  try {
    await page.goto('/scm/material-categories')
    await expect(
      page.getByRole('heading', { name: '物料分类', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('treegrid', {
        name: 'invMaterialCategories 数据表格',
      }),
    ).toBeVisible()
    await page.getByRole('button', { name: '新增', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '新增物料分类' })
    await expect(drawer).toBeVisible()
    await drawer.getByLabel('分类编号').fill(categoryCode)
    await drawer.getByLabel('分类名称').fill(categoryName)
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          '/api/v1/inventory/material-categories',
    )
    await drawer.getByRole('button', { name: '保存', exact: true }).click()
    const created = await expectOK(createResponse)
    categoryID = String(created?.id)
    expect(categoryID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    await expect(drawer).toBeHidden()

    const search = page.getByRole('searchbox', { name: '搜索' })
    await search.fill(categoryCode)
    const row = page.getByRole('row').filter({ hasText: categoryCode })
    await expect(row).toBeVisible()

    await page.goto('/scm/materials')
    await expect(
      page.getByRole('heading', { name: '物料管理', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('grid', { name: 'invMaterials 数据表格' }),
    ).toBeVisible()

    await page.goto('/scm/warehouses')
    await expect(
      page.getByRole('heading', { name: '仓库管理', exact: true }),
    ).toBeVisible()
    const warehouseGrid = page.getByRole('treegrid', {
      name: 'invWarehouses 数据表格',
    })
    const needsCompany = page.getByRole('heading', {
      name: '请先选择公司',
      exact: true,
    })
    const autoSelected = await warehouseGrid
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
    if (!autoSelected) {
      await expect(needsCompany).toBeVisible()
      await page.getByText('选择公司…', { exact: true }).click()
      await page.getByRole('option').first().click()
    }
    await expect(warehouseGrid).toBeVisible()

    await page.goto('/scm/stock-entries')
    await expect(
      page.getByRole('heading', { name: '库存分录流水', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('grid', { name: 'invStockEntries 数据表格' }),
    ).toBeVisible()

    await page.goto('/scm/inventory')
    await expect(
      page.getByRole('heading', { name: '库存余额', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() =>
        restRequests.includes('POST /api/v1/inventory/stock-balance/query'),
      )
      .toBe(true)

    for (const tab of [
      {
        route: '/scm/other-stock/docs',
        resource: 'invStockDocs',
        label: '出入库',
      },
      {
        route: '/scm/other-stock/transfers',
        resource: 'invStockTransfers',
        label: '调拨',
      },
      {
        route: '/scm/other-stock/counts',
        resource: 'invStockCounts',
        label: '盘点',
      },
    ]) {
      await page.goto(tab.route)
      await expect(
        page.getByRole('heading', { name: '其他库存单', exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole('tab', { name: tab.label, exact: true }),
      ).toHaveAttribute('aria-selected', 'true')
      await expect(
        page.getByRole('grid', {
          name: `${tab.resource} 数据表格`,
        }),
      ).toBeVisible()
    }

    await expect
      .poll(() =>
        [
          'invMaterialCategories',
          'invMaterials',
          'invWarehouses',
          'invStockEntries',
          'invStockDocs',
          'invStockTransfers',
          'invStockCounts',
        ].every((resource) =>
          restRequests.includes(`GET /api/v1/meta/resources/${resource}`),
        ),
      )
      .toBe(true)
    expect(
      restRequests,
      `实际库存 REST 请求:\n${restRequests.join('\n')}`,
    ).toEqual(
      expect.arrayContaining([
        'POST /api/v1/inventory/material-categories/query',
        'POST /api/v1/inventory/material-categories',
        'POST /api/v1/inventory/materials/query',
        'POST /api/v1/inventory/warehouses/query',
        'POST /api/v1/inventory/stock-entries/query',
        'POST /api/v1/inventory/stock-balance/query',
        'POST /api/v1/inventory/stock-docs/query',
        'POST /api/v1/inventory/stock-transfers/query',
        'POST /api/v1/inventory/stock-counts/query',
        'GET /api/v1/auth/me',
      ]),
    )
    expect(graphqlRequests).toEqual([])
  } finally {
    if (categoryID) {
      await cleanupCategory(token, categoryID)
      postgres(`
        DELETE FROM sys_audit_log
        WHERE record_id = '${categoryID}'::uuid
          AND resource = 'inv_material_category';
      `)
      const remaining = postgres(`
        SELECT
          (SELECT count(*) FROM inv_material_category WHERE id = '${categoryID}'::uuid),
          (SELECT count(*) FROM sys_audit_log WHERE record_id = '${categoryID}'::uuid);
      `)
      expect(remaining).toBe('0|0')
    }
  }
})
