import { execFileSync } from 'node:child_process'
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { loginViaUI } from './fixtures/session'

const pgContainer = process.env.SYNIE_PG_CONTAINER ?? 'synie-postgres-1'
const pgDatabase = process.env.SYNIE_PG_DB ?? 'synie'
const suffix = Date.now().toString(36).toUpperCase()
const prefix = `E2EMFG${suffix}`

type Fixture = {
  currencyId: string
  companyId: string
  unitId: string
  categoryId: string
  materialId: string
  componentId: string
  component2Id: string
  departmentId: string
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
      pgDatabase,
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
    component2 AS (
      INSERT INTO inv_material(code,name,spec,category_id,default_unit_id,active)
      SELECT '${prefix}RM2','${prefix}辅料','E2E',category.id,unit.id,true
      FROM category,unit
      RETURNING id
    ),
    department AS (
      INSERT INTO sys_department(company_id,code,name,path,enabled)
      SELECT company.id,'${prefix}DP','${prefix}车间','${prefix}DP',true FROM company
      RETURNING id
    ),
    warehouse AS (
      -- 仓库编码列 NOT NULL(迁移 00022 起 API 侧系统取号 B(W)-;夹具直写 SQL 自带编码)
      INSERT INTO inv_warehouse(code,name,company_id,is_leaf,active,allow_negative)
      SELECT '${prefix}W','${prefix}成品仓',company.id,true,true,false FROM company
      RETURNING id
    )
    SELECT currency.id::text,company.id::text,unit.id::text,category.id::text,
           material.id::text,component.id::text,component2.id::text,
           department.id::text,warehouse.id::text
    FROM currency,company,unit,category,material,component,component2,department,warehouse;
  `)
  const [
    currencyId,
    companyId,
    unitId,
    categoryId,
    materialId,
    componentId,
    component2Id,
    departmentId,
    warehouseId,
  ] = raw.split('|')
  expect(
    currencyId &&
      companyId &&
      unitId &&
      categoryId &&
      materialId &&
      componentId &&
      component2Id &&
      departmentId &&
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
    component2Id: component2Id!,
    departmentId: departmentId!,
    warehouseId: warehouseId!,
  }
}

async function post<T>(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown> = {},
  expected = 201,
): Promise<T> {
  // 调用侧传 page.request:与浏览器同 context,自动携带会话 cookie
  const response = await request.post(path, { data })
  const text = await response.text()
  expect(response.status(), `POST ${path}: ${response.status()} ${text}`).toBe(
    expected,
  )
  return JSON.parse(text) as T
}

/**
 * 行操作菜单动作（toggle 重试收敛）：搜索/失效刷新的行重渲染会卸载刚开的菜单，
 * networkidle 兜不住迟到的失效——「不可见则 toggle、短超时验证可见」循环直到稳定
 */
async function clickRowActionMenu(
  page: Page,
  row: Locator,
  actionName: string,
): Promise<void> {
  const item = page.getByRole('menuitem', { name: actionName, exact: true })
  await expect(async () => {
    if (!(await item.isVisible().catch(() => false))) {
      await row.getByRole('button', { name: '行操作' }).click()
    }
    await expect(item).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await item.click()
}

async function openDrawer(
  page: Page,
  /** 侧栏链接客户端导航（goto 直开走 SSR，业务 REST 不经浏览器、观测不到） */
  nav: { link: string; tab?: string },
  resource: string,
  searchText: string,
  label: string,
  pageErrors: string[],
  tab?: { label: string; expected: string },
  /** 无 tab 的抽屉（需求单抽屉需求行同屏）：直接断言抽屉内文本 */
  inlineExpected?: string,
  /** 抽屉内锚定文本：默认 searchText；编号只读后不再进 basic 抽屉（工序/工艺模板/BOM），传名称等可见文本 */
  drawerExpected?: string,
) {
  await page.getByRole('link', { name: nav.link, exact: true }).click()
  if (nav.tab) {
    await page.getByRole('tab', { name: nav.tab, exact: true }).click()
  }
  await expect(
    page.getByRole('grid', { name: `${resource} 数据表格` }),
    `页面运行时错误: ${pageErrors.join(' | ')}`,
  ).toBeVisible()
  const search = page.getByRole('searchbox', { name: '搜索' })
  await search.fill(searchText)
  const row = page.getByRole('row').filter({ hasText: searchText })
  await expect(row).toBeVisible()
  // 等搜索/失效刷新落定再开行操作：行重渲染会卸载已开的菜单（竞态，helper 内重试兜底）
  await page.waitForLoadState('networkidle')
  await clickRowActionMenu(page, row, '查看')
  const drawer = page.getByRole('dialog', { name: `${label}详情` })
  await expect(drawer).toBeVisible()
  await expect(
    drawer.getByText(drawerExpected ?? searchText, { exact: true }),
  ).toBeVisible()
  if (tab) {
    await drawer.getByRole('tab', { name: tab.label, exact: true }).click()
    await expect(drawer.getByText(tab.expected, { exact: false })).toBeVisible()
  }
  if (inlineExpected) {
    await expect(
      drawer.getByText(inlineExpected, { exact: false }).first(),
    ).toBeVisible()
  }
  await drawer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(drawer).toBeHidden()
}

/** 派生草稿 id 登记：行引用工单（source_work_order_id 无外键级联），必须先于工单清场 */
const derivedDemandIds: string[] = []
/** 主数据 id 登记：工序/工艺模板/BOM 编码均系统生成（不带 prefix），按 id 清场 */
const masterDataIds = {
  operations: [] as string[],
  templates: [] as string[],
  boms: [] as string[],
}

function idIn(ids: string[]): string {
  return ids.length === 0
    ? '(NULL::uuid)'
    : `(${ids.map((id) => `'${id}'::uuid`).join(',')})`
}

function cleanup(fixture: Fixture | null): void {
  if (!fixture) return
  if (derivedDemandIds.length > 0) {
    const ids = derivedDemandIds.map((id) => `'${id}'::uuid`).join(',')
    postgres(`
      DELETE FROM mfg_demand_item WHERE demand_id IN (${ids});
      DELETE FROM mfg_demand WHERE id IN (${ids});
    `)
  }
  postgres(`
    DELETE FROM sys_audit_log WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM inv_stock_entry WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_output WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_work_order WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_demand WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM mfg_bom WHERE id IN ${idIn(masterDataIds.boms)};
    DELETE FROM mfg_process_template WHERE id IN ${idIn(masterDataIds.templates)};
    DELETE FROM mfg_operation WHERE id IN ${idIn(masterDataIds.operations)};
    DELETE FROM sys_department WHERE id='${fixture.departmentId}'::uuid;
    DELETE FROM inv_warehouse WHERE id='${fixture.warehouseId}'::uuid;
    DELETE FROM inv_material
      WHERE id IN ('${fixture.materialId}'::uuid,'${fixture.componentId}'::uuid,'${fixture.component2Id}'::uuid);
    DELETE FROM inv_material_category WHERE id='${fixture.categoryId}'::uuid;
    DELETE FROM bas_company WHERE id='${fixture.companyId}'::uuid;
    DELETE FROM bas_unit WHERE id='${fixture.unitId}'::uuid;
    DELETE FROM bas_currency WHERE id='${fixture.currencyId}'::uuid;
  `)
}

test.setTimeout(180_000)

test('六个制造页面以 Go REST 加载 Grid、Drawer、子表并确认需求', async ({
  page,
}) => {
  // page.request 与浏览器同 context,自动携带会话 cookie(request fixture 不共享 cookie)
  const request = page.request
  let fixture: Fixture | null = null
  // mfg.operation 编号规则被本 spec 临时启用时,finally 恢复停用(见下)
  let restoreOperationRule = false
  const graphql: string[] = []
  const manufacturingREST: string[] = []
  const pageErrors: string[] = []
  // React 19 dev 下并发渲染的可恢复回退提示（自愈、页面行为正常）不入运行时错误账
  page.on('pageerror', (error) => {
    if (
      error.message.includes(
        'There was an error during concurrent rendering but React was able to recover',
      )
    ) {
      return
    }
    pageErrors.push(error.message)
  })
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
    await loginViaUI(page)

    // run-smoke.sh 为 numbering spec 预置「mfg.operation 编号规则停用」作候选;
    // 本 spec 建工序需系统按规则取号——直写 SQL 临时启用(与 run-smoke.sh 同口径、不留审计),
    // finally 恢复原状(workers=1 串行,不扰动其他 spec)
    const operationRuleState = postgres(
      `SELECT enabled FROM sys_numbering_rule WHERE resource='mfg.operation'`,
    )
    if (operationRuleState === 'f') {
      postgres(
        `UPDATE sys_numbering_rule SET enabled=true WHERE resource='mfg.operation'`,
      )
      restoreOperationRule = true
    }

    // 工序/工艺模板/BOM 编码由系统按规则生成:create 不再携带 code(手填即 400),从响应读出
    const operation = await post<Row>(
      request,
      '/api/v1/manufacturing/operations',
      { name: `${prefix}冲压` },
    )
    const operationCode = String(operation.code)
    expect(operationCode, '系统应生成工序编码').toBeTruthy()
    masterDataIds.operations.push(operation.id)
    const template = await post<Row>(
      request,
      '/api/v1/manufacturing/process-templates',
      { name: `${prefix}标准工艺` },
    )
    const templateCode = String(template.code)
    expect(templateCode, '系统应生成工艺模板编码').toBeTruthy()
    masterDataIds.templates.push(template.id)
    await post<Row>(
      request,
      '/api/v1/manufacturing/process-template-items',
      {
        templateId: template.id,
        operationId: operation.id,
        seq: 10,
        requirement: `${prefix}模板步骤`,
        isOutsourced: false,
      },
    )

    const bom = await post<Row>(request, '/api/v1/manufacturing/boms', {
      materialId: fixture.materialId,
      planName: `${prefix}内制方案`,
    })
    const bomCode = String(bom.code)
    expect(bomCode, '系统应生成 BOM 编码').toBeTruthy()
    masterDataIds.boms.push(bom.id)
    await post<Row>(request, '/api/v1/manufacturing/bom-components', {
      bomId: bom.id,
      materialId: fixture.componentId,
      unitId: fixture.unitId,
      quantity: '2',
      lossRate: '0.1',
      note: `${prefix}配料`,
    })
    await post<Row>(request, '/api/v1/manufacturing/bom-components', {
      bomId: bom.id,
      materialId: fixture.component2Id,
      unitId: fixture.unitId,
      quantity: '3',
      note: `${prefix}配料2`,
    })
    // 工单只收启用中 BOM：配料齐后启用，供工单选入快照
    await post<Row>(
      request,
      `/api/v1/manufacturing/boms/${bom.id}/activate`,
      {},
      200,
    )

    // 单据编号由系统按规则生成:create 不再携带 demandNo/workOrderNo/outputNo,从响应读出
    const demand = await post<Row>(
      request,
      '/api/v1/manufacturing/demands',
      {
        companyId: fixture.companyId,
        demandDate: '2026-07-26',
        assignType: 'PURCHASE',
      },
    )
    const demandNo = String(demand.demandNo)
    expect(demandNo, '系统应生成履约需求单编号').toBeTruthy()
    const demandItem = await post<Row>(
      request,
      '/api/v1/manufacturing/demand-items',
      {
        demandId: demand.id,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        idx: 1,
        qty: '5',
        needDate: '2026-07-30',
        remarks: `${prefix}需求行`,
      },
    )

    const uiDemand = await post<Row>(
      request,
      '/api/v1/manufacturing/demands',
      {
        companyId: fixture.companyId,
        demandDate: '2026-07-26',
        assignType: 'PURCHASE',
      },
    )
    const uiDemandNo = String(uiDemand.demandNo)
    expect(uiDemandNo, '系统应生成履约需求单编号').toBeTruthy()
    await post<Row>(request, '/api/v1/manufacturing/demand-items', {
      demandId: uiDemand.id,
      materialId: fixture.materialId,
      unitId: fixture.unitId,
      idx: 1,
      qty: '1',
      needDate: '2026-07-30',
    })

    await post<Row>(
      request,
      `/api/v1/manufacturing/demands/${demand.id}/confirm`,
      {},
      200,
    )
    const workOrder = await post<Row>(
      request,
      '/api/v1/manufacturing/work-orders',
      { demandItemId: demandItem.id, bomId: bom.id },
    )
    const workOrderNo = String(workOrder.workOrderNo)
    expect(workOrderNo, '系统应生成生产工单编号').toBeTruthy()
    const output = await post<Row>(
      request,
      '/api/v1/manufacturing/outputs',
      {
        companyId: fixture.companyId,
        outputDate: '2026-07-26',
        warehouseId: fixture.warehouseId,
      },
    )
    const outputNo = String(output.outputNo)
    expect(outputNo, '系统应生成生产入库单编号').toBeTruthy()
    await post<Row>(request, '/api/v1/manufacturing/output-items', {
      outputId: output.id,
      workOrderId: workOrder.id,
      unitId: fixture.unitId,
      warehouseId: fixture.warehouseId,
      idx: 1,
      qty: '2',
      remarks: `${prefix}入库行`,
    })

    // SSR 首屏只作导航靴点（侧栏链接在此页可见）；六个抽屉均经侧栏链接客户端导航进入，
    // 浏览器端才能观测到业务 REST（goto 直开走 SSR，请求发自前端服务端）
    await page.goto('/mfg/settings')
    await openDrawer(
      page,
      { link: '工序' },
      'mfgOperations',
      operationCode,
      '工序',
      pageErrors,
      undefined,
      undefined,
      // 工序编码只读、不进 basic 抽屉：以工序名称锚定
      `${prefix}冲压`,
    )
    await openDrawer(
      page,
      { link: '工艺模板' },
      'mfgProcessTemplates',
      templateCode,
      '工艺模板',
      pageErrors,
      { label: '工艺步骤', expected: `${prefix}冲压` },
      undefined,
      // 工艺模板编码只读、不进抽屉：以模板名称锚定
      `${prefix}标准工艺`,
    )
    await openDrawer(page, { link: 'BOM' }, 'mfgBoms', bomCode, 'BOM', pageErrors, {
      label: '配料',
      expected: `${prefix}原料`,
    })
    await openDrawer(
      page,
      { link: '履约需求单', tab: '需求单' },
      'mfgDemands',
      demandNo,
      '履约需求单',
      pageErrors,
      // 需求单抽屉无 tab：需求行同屏内联展示
      undefined,
      `${prefix}成品`,
    )
    await openDrawer(
      page,
      { link: '生产工单' },
      'mfgWorkOrders',
      workOrderNo,
      '生产工单',
      pageErrors,
    )
    await openDrawer(
      page,
      { link: '生产入库', tab: '入库单' },
      'mfgOutputs',
      outputNo,
      '生产入库单',
      pageErrors,
      // 入库单抽屉无 tab：入库条目同屏内联展示
      undefined,
      `${prefix}成品`,
    )

    await page.goto('/mfg/demands/orders')
    const search = page.getByRole('searchbox', { name: '搜索' })
    await search.fill(uiDemandNo)
    const uiRow = page.getByRole('row').filter({ hasText: uiDemandNo })
    await expect(uiRow).toContainText('草稿')
    // 同 openDrawer：等刷新落定再开行操作菜单（竞态，helper 内重试兜底）
    await page.waitForLoadState('networkidle')
    await clickRowActionMenu(page, uiRow, '审核')
    // 审核确认统一弹窗（列整单条目核对）：aria-label 审核履约需求单，按钮「确认审核」
    const confirm = page.getByRole('alertdialog', { name: '审核履约需求单' })
    await expect(confirm).toBeVisible()
    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        new URL(candidate.url()).pathname ===
          `/api/v1/manufacturing/demands/${uiDemand.id}/confirm`,
    )
    await confirm.getByRole('button', { name: '确认审核', exact: true }).click()
    expect((await response).ok()).toBeTruthy()
    await expect(uiRow).toContainText('已确认')

    // —— 工单物料需求派生：弹窗逐行选去向提交 → 草稿数量/去向分组 → 需求行来源工单列 ——
    // 预览端点取数：毛需求=净用量×(1+损耗率)×工单数量(5)，无现货→默认净需求=毛需求
    const preview = await request.get(
      `/api/v1/manufacturing/work-orders/${workOrder.id}/material-demand-preview`,
    )
    expect(preview.status(), `预览取数: ${preview.status()}`).toBe(200)
    const previewBody = (await preview.json()) as {
      lines: Array<{
        materialId: string
        grossQty: string
        stockQty: string
        defaultQty: string
      }>
    }
    expect(previewBody.lines).toHaveLength(2)
    const previewByMaterial = new Map(
      previewBody.lines.map((line) => [line.materialId, line]),
    )
    // 原料：2×(1+0.1)×5=11；辅料：3×1×5=15（损耗率空按 1）
    expect(
      Number(previewByMaterial.get(fixture.componentId)!.grossQty),
    ).toBe(11)
    expect(
      Number(previewByMaterial.get(fixture.component2Id)!.grossQty),
    ).toBe(15)

    // 工单列表行动作打开「生成物料需求」弹窗（弹窗内经预览端点取数渲染分流表格）
    await page.goto('/mfg/work-orders')
    await expect(
      page.getByRole('grid', { name: 'mfgWorkOrders 数据表格' }),
      `页面运行时错误: ${pageErrors.join(' | ')}`,
    ).toBeVisible()
    await page.getByRole('searchbox', { name: '搜索' }).fill(workOrderNo)
    const workOrderRow = page.getByRole('row').filter({ hasText: workOrderNo })
    await expect(workOrderRow).toBeVisible()
    // 同 openDrawer：等刷新落定再开行操作菜单（竞态，helper 内重试兜底）
    await page.waitForLoadState('networkidle')
    await clickRowActionMenu(page, workOrderRow, '生成物料需求')
    const deriveDialog = page.getByRole('dialog', { name: '生成物料需求' })
    await expect(deriveDialog).toBeVisible()
    // 逐行选去向：原料 → 车间，辅料 → 采购
    // 注：HeroUI Select 触发钮的可访问名=当前值+aria-label（如「不需要 xxx原料 去向」），用按钮名子串匹配
    const materialTarget = deriveDialog.getByRole('button', {
      name: `${prefix}原料 去向`,
    })
    await expect(materialTarget).toBeVisible()
    await materialTarget.click()
    await page
      .getByRole('option', { name: `${prefix}车间`, exact: true })
      .click()
    await deriveDialog
      .getByRole('button', { name: `${prefix}辅料 去向` })
      .click()
    await page.getByRole('option', { name: '采购', exact: true }).click()
    const deriveResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        new URL(candidate.url()).pathname ===
          `/api/v1/manufacturing/work-orders/${workOrder.id}/generate-material-demand`,
    )
    await deriveDialog
      .getByRole('button', { name: '生成需求单草稿', exact: true })
      .click()
    const deriveResult = (await (await deriveResponse).json()) as {
      warning: unknown
      demands: Array<{
        id: string
        demandNo: string
        assignedDeptId: string | null
      }>
    }
    // 按去向拆单：车间向一张（头已填下发车间）、采购向一张（下发为空）
    expect(deriveResult.warning).toBeNull()
    expect(deriveResult.demands).toHaveLength(2)
    const deptDraft = deriveResult.demands.find(
      (d) => d.assignedDeptId === fixture.departmentId,
    )
    const purchaseDraft = deriveResult.demands.find(
      (d) => d.assignedDeptId === null,
    )
    expect(deptDraft, '应生成车间向草稿').toBeDefined()
    expect(purchaseDraft, '应生成采购向草稿').toBeDefined()
    derivedDemandIds.push(...deriveResult.demands.map((d) => d.id))
    await expect(deriveDialog).toBeHidden()

    // 需求单列表可见两张派生草稿
    await page.goto('/mfg/demands/orders')
    await expect(
      page.getByRole('grid', { name: 'mfgDemands 数据表格' }),
    ).toBeVisible()
    const orderSearch = page.getByRole('searchbox', { name: '搜索' })
    for (const draft of [deptDraft!, purchaseDraft!]) {
      await orderSearch.fill(draft.demandNo)
      await expect(
        page.getByRole('row').filter({ hasText: draft.demandNo }),
      ).toContainText('草稿')
    }

    // 需求行列表「来源工单」列展示来源工单号（只读链接）
    await page.goto('/mfg/demands/items')
    await expect(
      page.getByRole('grid', { name: 'mfgDemandItems 数据表格' }),
    ).toBeVisible()
    await page.getByRole('searchbox', { name: '搜索' }).fill(`${prefix}RM`)
    await expect(
      page.getByRole('row').filter({ hasText: workOrderNo }),
    ).toHaveCount(2)

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
    // 派生链路浏览器请求：弹窗预览取数 + 生成物料需求
    for (const endpoint of [
      'material-demand-preview',
      'generate-material-demand',
    ]) {
      expect(
        manufacturingREST.some((entry) => entry.includes(endpoint)),
        `浏览器未观察到 ${endpoint}`,
      ).toBe(true)
    }
  } finally {
    if (restoreOperationRule) {
      postgres(
        `UPDATE sys_numbering_rule SET enabled=false WHERE resource='mfg.operation'`,
      )
    }
    cleanup(fixture)
  }
})
