import { execFileSync } from 'node:child_process'
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password =
  process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const pgContainer = process.env.SYNIE_PG_CONTAINER ?? 'synie-postgres-1'
const suffix = Date.now().toString(36).toUpperCase()
const prefix = `E2EMFG${suffix}`

type Fixture = {
  currencyId: string
  companyId: string
  unitId: string
  categoryId: string
  materialId: string
  componentId: string
  warehouseId: string
}

type Row = { id: string; [key: string]: unknown }

function postgres(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      pgContainer,
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

function createFixture(): Fixture {
  const raw = postgres(`
    WITH currency AS (
      INSERT INTO bas_currency(name,iso_code,symbol,active)
      VALUES ('${prefix}验收币','${prefix}CUR','¤',true)
      RETURNING id
    ),
    company AS (
      INSERT INTO bas_company(code,name,short_name,base_currency_id)
      SELECT '${prefix}CO','${prefix}验收公司','${prefix}公司',id FROM currency
      RETURNING id
    ),
    unit AS (
      INSERT INTO bas_unit(unit_type,is_base,name,symbol,ratio)
      VALUES ('quantity',false,'${prefix}件','${prefix}EA',1)
      RETURNING id
    ),
    category AS (
      INSERT INTO inv_material_category(code,name,is_leaf,active)
      VALUES ('${prefix}CAT','${prefix}分类',true,true)
      RETURNING id
    ),
    material AS (
      INSERT INTO inv_material(code,name,spec,category_id,default_unit_id,active)
      SELECT '${prefix}FG','${prefix}成品','E2E',category.id,unit.id,true
      FROM category,unit
      RETURNING id
    ),
    component AS (
      INSERT INTO inv_material(code,name,spec,category_id,default_unit_id,active)
      SELECT '${prefix}RM','${prefix}原料','E2E',category.id,unit.id,true
      FROM category,unit
      RETURNING id
    ),
    warehouse AS (
      INSERT INTO inv_warehouse(name,company_id,is_leaf,active,allow_negative)
      SELECT '${prefix}成品仓',company.id,true,true,false FROM company
      RETURNING id
    )
    SELECT currency.id::text,company.id::text,unit.id::text,category.id::text,
           material.id::text,component.id::text,warehouse.id::text
    FROM currency,company,unit,category,material,component,warehouse;
  `)
  const [
    currencyId,
    companyId,
    unitId,
    categoryId,
    materialId,
    componentId,
    warehouseId,
  ] = raw.split('|')
  expect(
    currencyId &&
      companyId &&
      unitId &&
      categoryId &&
      materialId &&
      componentId &&
      warehouseId,
    '制造浏览器夹具创建失败',
  ).toBeTruthy()
  return {
    currencyId: currencyId!,
    companyId: companyId!,
    unitId: unitId!,
    categoryId: categoryId!,
    materialId: materialId!,
    componentId: componentId!,
    warehouseId: warehouseId!,
  }
}

async function login(page: Page): Promise<string> {
  await page.goto('/login')
  const user = page.getByRole('textbox', { name: '用户名', exact: true })
  const pass = page.getByRole('textbox', { name: '密码', exact: true })
  await expect
    .poll(() =>
      user.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith('__reactProps$')),
      ),
    )
    .toBe(true)
  await user.pressSequentially(username)
  await pass.pressSequentially(password)
  await page.getByRole('button', { name: /登\s*录|正在登录/ }).click()
  await expect(page.getByRole('navigation', { name: '模块导航' })).toBeVisible()
  const token = await page.evaluate(() =>
    window.localStorage.getItem('synie:token'),
  )
  expect(token).toBeTruthy()
  return token!
}

async function post<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data: Record<string, unknown> = {},
  expected = 201,
): Promise<T> {
  const response = await request.post(path, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  })
  const text = await response.text()
  expect(response.status(), `POST ${path}: ${response.status()} ${text}`).toBe(
    expected,
  )
  return JSON.parse(text) as T
}

async function openDrawer(
  page: Page,
  path: string,
  resource: string,
  searchText: string,
  label: string,
  pageErrors: string[],
  tab?: { label: string; expected: string },
) {
  await page.goto(path)
  await expect(
    page.getByRole('grid', { name: `${resource} 数据表格` }),
    `页面运行时错误: ${pageErrors.join(' | ')}`,
  ).toBeVisible()
  const search = page.getByRole('searchbox', { name: '搜索' })
  await search.fill(searchText)
  const row = page.getByRole('row').filter({ hasText: searchText })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '行操作' }).click()
  await page.getByRole('menuitem', { name: '查看', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: `${label}详情` })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText(searchText, { exact: true })).toBeVisible()
  if (tab) {
    await drawer.getByRole('tab', { name: tab.label, exact: true }).click()
    await expect(drawer.getByText(tab.expected, { exact: false })).toBeVisible()
  }
  await drawer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(drawer).toBeHidden()
}

function cleanup(fixture: Fixture | null): void {
  if (!fixture) return
  postgres(`
    DELETE FROM sys_audit_log WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM inv_stock_entry WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_output WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_work_order WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_demand WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_bom WHERE code LIKE '${prefix}%';
    DELETE FROM mfg_process_template WHERE code LIKE '${prefix}%';
    DELETE FROM mfg_operation WHERE code LIKE '${prefix}%';
    DELETE FROM inv_warehouse WHERE id='${fixture.warehouseId}'::uuid;
    DELETE FROM inv_material
      WHERE id IN ('${fixture.materialId}'::uuid,'${fixture.componentId}'::uuid);
    DELETE FROM inv_material_category WHERE id='${fixture.categoryId}'::uuid;
    DELETE FROM bas_company WHERE id='${fixture.companyId}'::uuid;
    DELETE FROM bas_unit WHERE id='${fixture.unitId}'::uuid;
    DELETE FROM bas_currency WHERE id='${fixture.currencyId}'::uuid;
  `)
}

test.setTimeout(180_000)

test('六个制造页面以 Go REST 加载 Grid、Drawer、子表并确认需求', async ({
  page,
  request,
}) => {
  let fixture: Fixture | null = null
  const graphql: string[] = []
  const manufacturingREST: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname
    if (path === '/graphql') {
      graphql.push(`${req.method()} ${path} ${req.postData() ?? ''}`)
    }
    if (path.startsWith('/api/v1/manufacturing/')) {
      manufacturingREST.push(`${req.method()} ${path}`)
    }
  })

  try {
    fixture = createFixture()
    const token = await login(page)

    const operationCode = `${prefix}OP`
    const operation = await post<Row>(
      request,
      '/api/v1/manufacturing/operations',
      token,
      { code: operationCode, name: `${prefix}冲压` },
    )
    const templateCode = `${prefix}RT`
    const template = await post<Row>(
      request,
      '/api/v1/manufacturing/process-templates',
      token,
      { code: templateCode, name: `${prefix}标准工艺` },
    )
    await post<Row>(
      request,
      '/api/v1/manufacturing/process-template-items',
      token,
      {
        templateId: template.id,
        operationId: operation.id,
        seq: 10,
        requirement: `${prefix}模板步骤`,
        isOutsourced: false,
      },
    )

    const bomCode = `${prefix}BOM`
    const bom = await post<Row>(request, '/api/v1/manufacturing/boms', token, {
      code: bomCode,
      materialId: fixture.materialId,
      planName: `${prefix}内制方案`,
    })
    await post<Row>(request, '/api/v1/manufacturing/bom-components', token, {
      bomId: bom.id,
      materialId: fixture.componentId,
      unitId: fixture.unitId,
      quantity: '2',
      lossRate: '0.1',
      note: `${prefix}配料`,
    })

    const demandNo = `${prefix}D`
    const demand = await post<Row>(
      request,
      '/api/v1/manufacturing/demands',
      token,
      {
        companyId: fixture.companyId,
        demandNo,
        demandDate: '2026-07-26',
      },
    )
    const demandItem = await post<Row>(
      request,
      '/api/v1/manufacturing/demand-items',
      token,
      {
        demandId: demand.id,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        idx: 1,
        qty: '5',
        remarks: `${prefix}需求行`,
      },
    )

    const uiDemandNo = `${prefix}UI`
    const uiDemand = await post<Row>(
      request,
      '/api/v1/manufacturing/demands',
      token,
      {
        companyId: fixture.companyId,
        demandNo: uiDemandNo,
        demandDate: '2026-07-26',
      },
    )
    await post<Row>(request, '/api/v1/manufacturing/demand-items', token, {
      demandId: uiDemand.id,
      materialId: fixture.materialId,
      unitId: fixture.unitId,
      idx: 1,
      qty: '1',
    })

    await post<Row>(
      request,
      `/api/v1/manufacturing/demands/${demand.id}/confirm`,
      token,
      {},
      200,
    )
    const workOrderNo = `${prefix}WO`
    const workOrder = await post<Row>(
      request,
      '/api/v1/manufacturing/work-orders',
      token,
      { demandItemId: demandItem.id, workOrderNo },
    )
    const outputNo = `${prefix}OUT`
    const output = await post<Row>(
      request,
      '/api/v1/manufacturing/outputs',
      token,
      {
        companyId: fixture.companyId,
        outputNo,
        outputDate: '2026-07-26',
        warehouseId: fixture.warehouseId,
      },
    )
    await post<Row>(request, '/api/v1/manufacturing/output-items', token, {
      outputId: output.id,
      workOrderId: workOrder.id,
      unitId: fixture.unitId,
      warehouseId: fixture.warehouseId,
      idx: 1,
      qty: '2',
      remarks: `${prefix}入库行`,
    })

    await openDrawer(
      page,
      '/mfg/operations',
      'mfgOperations',
      operationCode,
      '工序',
      pageErrors,
    )
    await openDrawer(
      page,
      '/mfg/process-templates',
      'mfgProcessTemplates',
      templateCode,
      '工艺模板',
      pageErrors,
      { label: '工艺步骤', expected: `${prefix}冲压` },
    )
    await openDrawer(page, '/mfg/boms', 'mfgBoms', bomCode, 'BOM', pageErrors, {
      label: '配料',
      expected: `${prefix}原料`,
    })
    await openDrawer(
      page,
      '/mfg/demands/orders',
      'mfgDemands',
      demandNo,
      '履约需求单',
      pageErrors,
      { label: '需求行', expected: `${prefix}成品` },
    )
    await openDrawer(
      page,
      '/mfg/work-orders',
      'mfgWorkOrders',
      workOrderNo,
      '生产工单',
      pageErrors,
    )
    await openDrawer(
      page,
      '/mfg/outputs',
      'mfgOutputs',
      outputNo,
      '生产入库单',
      pageErrors,
      { label: '入库行', expected: `${prefix}成品` },
    )

    await page.goto('/mfg/demands/orders')
    const search = page.getByRole('searchbox', { name: '搜索' })
    await search.fill(uiDemandNo)
    const uiRow = page.getByRole('row').filter({ hasText: uiDemandNo })
    await expect(uiRow).toContainText('草稿')
    await uiRow.getByRole('button', { name: '行操作' }).click()
    await page.getByRole('menuitem', { name: '确认', exact: true }).click()
    const confirm = page.getByRole('alertdialog', { name: '确认确认' })
    await expect(confirm).toBeVisible()
    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        new URL(candidate.url()).pathname ===
          `/api/v1/manufacturing/demands/${uiDemand.id}/confirm`,
    )
    await confirm.getByRole('button', { name: '确认', exact: true }).click()
    expect((await response).ok()).toBeTruthy()
    await expect(uiRow).toContainText('已确认')

    expect(pageErrors, '制造页面不应产生运行时错误').toEqual([])
    expect(graphql, '制造消费面不得发业务 GraphQL').toEqual([])
    for (const endpoint of [
      '/manufacturing/operations/query',
      '/manufacturing/process-templates/query',
      '/manufacturing/process-template-items/query',
      '/manufacturing/boms/query',
      '/manufacturing/bom-components/query',
      '/manufacturing/demands/query',
      '/manufacturing/demand-items/query',
      '/manufacturing/work-orders/query',
      '/manufacturing/outputs/query',
      '/manufacturing/output-items/query',
    ]) {
      expect(
        manufacturingREST.some((entry) => entry.includes(endpoint)),
        `浏览器未观察到 ${endpoint}`,
      ).toBe(true)
    }
  } finally {
    cleanup(fixture)
  }
})
