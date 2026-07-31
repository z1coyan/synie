import { SQL } from 'bun'
import { join } from 'node:path'

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  'postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable'
const db = new SQL(databaseURL)
const suffix = crypto
  .randomUUID()
  .replaceAll('-', '')
  .slice(0, 10)
  .toUpperCase()
const prefix = `ZZR217${suffix}`
const missingID = crypto.randomUUID()

type Row = Record<string, unknown> & { id: string }
type List<T> = { count: number; results: T[] }
type AuthHeaders = Record<string, string>
type Fixture = {
  currencyId: string
  companyId: string
  otherCurrencyId: string
  otherCompanyId: string
  unitId: string
  categoryId: string
  materialId: string
  componentId: string
  warehouseId: string
  salesOrderId: string
  salesOrderItemId: string
}
type Demand = Row & {
  demandNo: string
  companyId: string
  remarks: string | null
  status: 'DRAFT' | 'CONFIRMED' | 'CLOSED' | 'VOIDED'
}
type DemandItem = Row & {
  demandId: string
  qty: string
  baseQty: string
  orderedQty: string
  receivedQty: string
  fulfillmentMethod: 'MAKE' | 'BUY' | 'OUTSOURCE' | 'STOCK'
  status: 'PENDING' | 'SCHEDULED' | 'COMPLETED'
  ordered: boolean
  remainingOrderableQty: string
}
type WorkOrder = Row & {
  workOrderNo: string
  demandItemId: string
  receivedBaseQty: string
  remainingBaseQty: string
  status: 'IN_PROGRESS' | 'COMPLETED' | 'VOIDED'
}
type Output = Row & {
  outputNo: string
  status: 'DRAFT' | 'AUDITED' | 'VOIDED'
  auditedAt: string | null
}
type Occupancy = {
  salesOrderItemId: string
  orderedBaseQty: string
  occupiedBaseQty: string
  remainingBaseQty: string
}

const resources = [
  'mfgOperations',
  'mfgProcessTemplates',
  'mfgProcessTemplateItems',
  'mfgBoms',
  'mfgBomComponents',
  'mfgBomRoutes',
  'mfgBomByproducts',
  'mfgDemands',
  'mfgDemandItems',
  'mfgWorkOrders',
  'mfgOutputs',
  'mfgOutputItems',
] as const

const readOnlyPermissions = [
  'mfg.operation:read',
  'mfg.route_template:read',
  'mfg.bom:read',
  'mfg.demand:read',
  'mfg.work_order:read',
  'mfg.output:read',
] as const

const endpoints = [
  { path: '/manufacturing/operations', permission: 'mfg.operation' },
  {
    path: '/manufacturing/process-templates',
    permission: 'mfg.route_template',
  },
  {
    path: '/manufacturing/process-template-items',
    permission: 'mfg.route_template',
  },
  { path: '/manufacturing/boms', permission: 'mfg.bom' },
  { path: '/manufacturing/bom-components', permission: 'mfg.bom' },
  { path: '/manufacturing/bom-routes', permission: 'mfg.bom' },
  { path: '/manufacturing/bom-byproducts', permission: 'mfg.bom' },
  { path: '/manufacturing/demands', permission: 'mfg.demand' },
  { path: '/manufacturing/demand-items', permission: 'mfg.demand' },
  { path: '/manufacturing/work-orders', permission: 'mfg.work_order' },
  { path: '/manufacturing/outputs', permission: 'mfg.output' },
  { path: '/manufacturing/output-items', permission: 'mfg.output' },
] as const

let roleId: string | null = null
let userId: string | null = null
let graphqlCalls = 0
let permissionFirst = 0
let parentPermissionChecks = 0
let cleanupCount = -1

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function body(value: unknown) {
  return JSON.stringify(value)
}

function authHeaders(token: string): AuthHeaders {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    )
  }
  return value
}

function same(actual: unknown, expected: unknown, label: string) {
  const got = JSON.stringify(stable(actual))
  const want = JSON.stringify(stable(expected))
  assert(got === want, `${label} 不一致\nactual=${got}\nexpected=${want}`)
}

async function rawRequest(path: string, init: RequestInit = {}) {
  if (new URL(baseURL + path).pathname.endsWith('/graphql')) graphqlCalls++
  return fetch(baseURL + path, init)
}

async function requestText(
  path: string,
  init: RequestInit = {},
  expected = 200,
) {
  const response = await rawRequest(path, init)
  const text = await response.text()
  if (response.status !== expected) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: ${response.status}, want ${expected}, ${text}`,
    )
  }
  return text
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expected = 200,
) {
  const text = await requestText(path, init, expected)
  return (text ? JSON.parse(text) : undefined) as T
}

async function login(username: string, password: string) {
  const result = await request<{ token: string }>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body({ username, password }),
  })
  return authHeaders(result.token)
}

async function snapshot(resource: string, actor: 'superadmin' | 'read-only') {
  return Bun.file(
    join(
      import.meta.dir,
      'snapshots',
      'pr-2.17',
      `${resource}.${actor}.grid.json`,
    ),
  ).json()
}

function fk(value: string) {
  return { kind: 'fk', op: 'in', values: [value], labels: [] }
}

async function query<T>(
  path: string,
  auth: AuthHeaders,
  filter: Record<string, unknown> = {},
  sort?: { column: string; direction: 'ascending' | 'descending' },
) {
  return request<List<T>>(`${path}/query`, {
    method: 'POST',
    headers: auth,
    body: body({ limit: 200, offset: 0, filter, ...(sort ? { sort } : {}) }),
  })
}

async function setPermissions(
  admin: AuthHeaders,
  permissions: readonly string[],
) {
  assert(roleId, '验收角色尚未创建')
  await request(`/system/roles/${roleId}/permissions`, {
    method: 'PUT',
    headers: admin,
    body: body({ permissions }),
  })
}

async function expectPermissionFirst(path: string, init: RequestInit) {
  await requestText(path, init, 403)
  permissionFirst++
}

async function createFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    currencyId: crypto.randomUUID(),
    companyId: crypto.randomUUID(),
    otherCurrencyId: crypto.randomUUID(),
    otherCompanyId: crypto.randomUUID(),
    unitId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    materialId: crypto.randomUUID(),
    componentId: crypto.randomUUID(),
    warehouseId: crypto.randomUUID(),
    salesOrderId: crypto.randomUUID(),
    salesOrderItemId: crypto.randomUUID(),
  }
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES
        (${fixture.currencyId}::uuid,${prefix + '验收币'},${'M' + suffix},'¤',true),
        (${fixture.otherCurrencyId}::uuid,${prefix + '域外币'},${'N' + suffix},'¤',true)
    `
    await tx`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES
        (${fixture.companyId}::uuid,${'M' + suffix},${prefix + '验收公司'},${prefix + '公司'},${fixture.currencyId}::uuid),
        (${fixture.otherCompanyId}::uuid,${'N' + suffix},${prefix + '域外公司'},${prefix + '域外'},${fixture.otherCurrencyId}::uuid)
    `
    await tx`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES(${fixture.unitId}::uuid,'quantity',false,${prefix + '件'},${'EA' + suffix},1)
    `
    await tx`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES(${fixture.categoryId}::uuid,${'MC' + suffix},${prefix + '分类'},true,true)
    `
    await tx`
      INSERT INTO inv_material(id,code,name,spec,category_id,default_unit_id,active)
      VALUES
        (${fixture.materialId}::uuid,${'FG' + suffix},${prefix + '成品'},'MFG',${fixture.categoryId}::uuid,${fixture.unitId}::uuid,true),
        (${fixture.componentId}::uuid,${'RM' + suffix},${prefix + '原料'},'MFG',${fixture.categoryId}::uuid,${fixture.unitId}::uuid,true)
    `
    await tx`
      INSERT INTO inv_warehouse(id,name,company_id,is_leaf,active,allow_negative)
      VALUES(${fixture.warehouseId}::uuid,${prefix + '成品仓'},${fixture.companyId}::uuid,true,true,false)
    `
    await tx`
      INSERT INTO sal_order(
        id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,order_type
      ) VALUES(
        ${fixture.salesOrderId}::uuid,${prefix + '-SO'},'2026-07-26','customer',
        ${crypto.randomUUID()}::uuid,'audited',${fixture.companyId}::uuid,1,
        ${fixture.currencyId}::uuid,'regular'
      )
    `
    await tx`
      INSERT INTO sal_order_item(
        id,idx,qty,base_qty,price,amount,tax_rate,order_id,company_id,
        material_id,unit_id,material_code,material_name,unit_name,base_price,base_amount
      ) VALUES(
        ${fixture.salesOrderItemId}::uuid,1,10,10,1,10,0.13,
        ${fixture.salesOrderId}::uuid,${fixture.companyId}::uuid,
        ${fixture.materialId}::uuid,${fixture.unitId}::uuid,
        ${'FG' + suffix},${prefix + '成品'},${prefix + '件'},1,10
      )
    `
  })
  return fixture
}

async function createDemand(
  admin: AuthHeaders,
  fixture: Fixture,
  discriminator: string,
  method: 'MAKE' | 'BUY' | 'OUTSOURCE' | 'STOCK',
  qty: string,
  salesOrderItemId: string | null = null,
) {
  const demand = await request<Demand>(
    '/manufacturing/demands',
    {
      method: 'POST',
      headers: admin,
      body: body({
        companyId: fixture.companyId,
        demandNo: `${prefix}-D-${discriminator}`,
        demandDate: '2026-07-26',
        remarks: `${prefix}${discriminator}`,
      }),
    },
    201,
  )
  const item = await request<DemandItem>(
    '/manufacturing/demand-items',
    {
      method: 'POST',
      headers: admin,
      body: body({
        demandId: demand.id,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        salesOrderItemId,
        idx: 1,
        qty,
        fulfillmentMethod: method,
      }),
    },
    201,
  )
  return { demand, item }
}

async function concurrentStatuses(
  path: string,
  init: RequestInit,
  expected: number[],
) {
  const responses = await Promise.all([
    rawRequest(path, init),
    rawRequest(path, init),
  ])
  const statuses = responses.map((response) => response.status).sort()
  await Promise.all(responses.map((response) => response.body?.cancel()))
  same(statuses, [...expected].sort(), `${path} 并发状态`)
  return statuses
}

async function cleanup(fixture: Fixture | null) {
  try {
    if (userId) {
      await db`DELETE FROM sys_user_role WHERE user_id=${userId}::uuid`
      await db`DELETE FROM sys_user_company WHERE user_id=${userId}::uuid`
      await db`DELETE FROM sys_user WHERE id=${userId}::uuid`
      userId = null
    }
    if (roleId) {
      await db`DELETE FROM sys_role_permission WHERE role_id=${roleId}::uuid`
      await db`DELETE FROM sys_role WHERE id=${roleId}::uuid`
      roleId = null
    }
    if (!fixture) return
    await db`DELETE FROM sys_audit_log WHERE company_id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`
    await db`DELETE FROM inv_stock_entry WHERE company_id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`
    await db`DELETE FROM mfg_output WHERE company_id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`
    await db`DELETE FROM mfg_work_order WHERE company_id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`
    await db`DELETE FROM mfg_demand WHERE company_id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`
    await db`DELETE FROM mfg_bom WHERE code LIKE ${prefix + '%'}`
    await db`DELETE FROM mfg_process_template WHERE code LIKE ${prefix + '%'}`
    await db`DELETE FROM mfg_operation WHERE code LIKE ${prefix + '%'}`
    await db`DELETE FROM sal_order WHERE id=${fixture.salesOrderId}::uuid`
    await db`DELETE FROM inv_warehouse WHERE id=${fixture.warehouseId}::uuid`
    await db`DELETE FROM inv_material WHERE id IN (${fixture.materialId}::uuid,${fixture.componentId}::uuid)`
    await db`DELETE FROM inv_material_category WHERE id=${fixture.categoryId}::uuid`
    await db`DELETE FROM bas_company WHERE id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`
    await db`DELETE FROM bas_unit WHERE id=${fixture.unitId}::uuid`
    await db`DELETE FROM bas_currency WHERE id IN (${fixture.currencyId}::uuid,${fixture.otherCurrencyId}::uuid)`
    const remaining = await db`
      SELECT
        (SELECT count(*) FROM bas_company WHERE name LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM bas_currency WHERE name LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM mfg_operation WHERE code LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM mfg_process_template WHERE code LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM mfg_bom WHERE code LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM mfg_demand WHERE demand_no LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM mfg_work_order WHERE work_order_no LIKE ${prefix + '%'}) +
        (SELECT count(*) FROM mfg_output WHERE output_no LIKE ${prefix + '%'})
        AS count
    `
    cleanupCount = Number(remaining[0]?.count ?? -1)
  } finally {
    await db.close()
  }
}

let fixture: Fixture | null = null
let acceptanceSummary = ''
try {
  fixture = await createFixture()
  const admin = await login(
    process.env.E2E_ADMIN_USERNAME ?? 'admin',
    process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
  )

  for (const resource of resources) {
    const meta = await request<{ grid: unknown }>(
      `/meta/resources/${resource}`,
      { headers: admin },
    )
    same(
      meta.grid,
      await snapshot(resource, 'superadmin'),
      `${resource} superadmin Meta`,
    )
  }

  const role = await request<Row>(
    '/system/roles',
    {
      method: 'POST',
      headers: admin,
      body: body({ code: `${prefix}_reader`, name: `${prefix}验收角色` }),
    },
    201,
  )
  roleId = role.id
  const limited = await request<{
    user: Row & { username: string }
    password: string
  }>(
    '/system/users',
    {
      method: 'POST',
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}reader`,
        name: `${prefix}验收用户`,
        roleIds: [role.id],
        companyIds: [fixture.companyId],
      }),
    },
    201,
  )
  userId = limited.user.id
  const noPermission = await login(limited.user.username, limited.password)

  for (const resource of resources) {
    await expectPermissionFirst(`/meta/resources/${resource}`, {
      headers: noPermission,
    })
  }
  for (const endpoint of endpoints) {
    await expectPermissionFirst(`${endpoint.path}/query`, {
      method: 'POST',
      headers: noPermission,
      body: '{',
    })
    await expectPermissionFirst(endpoint.path, {
      method: 'POST',
      headers: noPermission,
      body: '{',
    })
    await expectPermissionFirst(`${endpoint.path}/${missingID}`, {
      headers: noPermission,
    })
    await expectPermissionFirst(`${endpoint.path}/${missingID}`, {
      method: 'PATCH',
      headers: noPermission,
      body: '{',
    })
    await expectPermissionFirst(`${endpoint.path}/${missingID}`, {
      method: 'DELETE',
      headers: noPermission,
    })
  }
  for (const [path, permission] of [
    [`/manufacturing/boms/${missingID}/apply-route-template`, 'mfg.bom:update'],
    [`/manufacturing/demands/${missingID}/confirm`, 'mfg.demand:confirm'],
    [`/manufacturing/demands/${missingID}/close`, 'mfg.demand:close'],
    [`/manufacturing/demands/${missingID}/void`, 'mfg.demand:void'],
    [`/manufacturing/demand-items/${missingID}/complete`, 'mfg.demand:update'],
    [
      `/manufacturing/demand-items/${missingID}/fulfillment`,
      'mfg.demand:update',
    ],
    [`/manufacturing/work-orders/${missingID}/void`, 'mfg.work_order:void'],
    [`/manufacturing/outputs/${missingID}/audit`, 'mfg.output:audit'],
    [`/manufacturing/outputs/${missingID}/void`, 'mfg.output:void'],
    ['/manufacturing/sales-item-occupancies', 'mfg.demand:read'],
  ] as const) {
    await expectPermissionFirst(path, {
      method: 'POST',
      headers: noPermission,
      body: '{',
    })
    assert(permission.length > 0, '动作权限声明缺失')
  }

  // 行资源不发明独立权限点：授予父资源权限后，请求必须越过 403，
  // 再由不存在的父记录/行或业务输入返回 400/404。
  for (const check of [
    {
      permission: 'mfg.route_template:create',
      path: '/manufacturing/process-template-items',
      payload: {
        templateId: missingID,
        operationId: missingID,
        seq: 1,
      },
    },
    {
      permission: 'mfg.bom:create',
      path: '/manufacturing/bom-components',
      payload: {
        bomId: missingID,
        materialId: missingID,
        unitId: missingID,
        quantity: '1',
      },
    },
    {
      permission: 'mfg.bom:create',
      path: '/manufacturing/bom-routes',
      payload: { bomId: missingID, operationId: missingID, seq: 1 },
    },
    {
      permission: 'mfg.bom:create',
      path: '/manufacturing/bom-byproducts',
      payload: {
        bomId: missingID,
        materialId: missingID,
        unitId: missingID,
        quantity: '1',
      },
    },
    {
      permission: 'mfg.demand:create',
      path: '/manufacturing/demand-items',
      payload: {
        demandId: missingID,
        materialId: missingID,
        unitId: missingID,
        idx: 1,
        qty: '1',
        fulfillmentMethod: 'MAKE',
      },
    },
    {
      permission: 'mfg.output:create',
      path: '/manufacturing/output-items',
      payload: {
        outputId: missingID,
        workOrderId: missingID,
        unitId: missingID,
        warehouseId: missingID,
        idx: 1,
        qty: '1',
      },
    },
  ]) {
    await setPermissions(admin, [check.permission])
    const parentActor = await login(limited.user.username, limited.password)
    const response = await rawRequest(check.path, {
      method: 'POST',
      headers: parentActor,
      body: body(check.payload),
    })
    const text = await response.text()
    assert(
      response.status !== 403 && response.status >= 400,
      `${check.path} 未复用父权限：${response.status} ${text}`,
    )
    parentPermissionChecks++
  }
  for (const check of [
    {
      permission: 'mfg.route_template:update',
      path: '/manufacturing/process-template-items',
    },
    { permission: 'mfg.bom:update', path: '/manufacturing/bom-components' },
    { permission: 'mfg.bom:update', path: '/manufacturing/bom-routes' },
    { permission: 'mfg.bom:update', path: '/manufacturing/bom-byproducts' },
    { permission: 'mfg.demand:update', path: '/manufacturing/demand-items' },
    { permission: 'mfg.output:update', path: '/manufacturing/output-items' },
  ]) {
    await setPermissions(admin, [check.permission])
    const parentActor = await login(limited.user.username, limited.password)
    for (const method of ['PATCH', 'DELETE']) {
      const response = await rawRequest(`${check.path}/${missingID}`, {
        method,
        headers: parentActor,
        ...(method === 'PATCH' ? { body: '{}' } : {}),
      })
      const text = await response.text()
      assert(
        response.status !== 403 && response.status >= 400,
        `${method} ${check.path} 未复用父 update 权限：${response.status} ${text}`,
      )
      parentPermissionChecks++
    }
  }

  await setPermissions(admin, readOnlyPermissions)
  const readOnly = await login(limited.user.username, limited.password)
  for (const resource of resources) {
    const meta = await request<{ grid: unknown }>(
      `/meta/resources/${resource}`,
      { headers: readOnly },
    )
    same(
      meta.grid,
      await snapshot(resource, 'read-only'),
      `${resource} read-only Meta`,
    )
  }

  const operation = await request<Row>(
    '/manufacturing/operations',
    {
      method: 'POST',
      headers: admin,
      body: body({
        code: `${prefix}OP`,
        name: `${prefix}工序`,
        note: null,
      }),
    },
    201,
  )
  const updatedOperation = await request<Row>(
    `/manufacturing/operations/${operation.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ name: `${prefix}工序已改`, note: `${prefix}备注` }),
    },
  )
  assert(
    updatedOperation.name === `${prefix}工序已改`,
    '工序 update 序列化错误',
  )
  const gotOperation = await request<Row>(
    `/manufacturing/operations/${operation.id}`,
    { headers: admin },
  )
  assert(gotOperation.id === operation.id, '工序 get 失败')

  const disposableOperation = await request<Row>(
    '/manufacturing/operations',
    {
      method: 'POST',
      headers: admin,
      body: body({ code: `${prefix}OPDEL`, name: `${prefix}待删工序` }),
    },
    201,
  )
  await requestText(
    `/manufacturing/operations/${disposableOperation.id}`,
    { method: 'DELETE', headers: admin },
    204,
  )

  const template = await request<Row>(
    '/manufacturing/process-templates',
    {
      method: 'POST',
      headers: admin,
      body: body({ code: `${prefix}RT`, name: `${prefix}工艺模板` }),
    },
    201,
  )
  await request<Row>(`/manufacturing/process-templates/${template.id}`, {
    method: 'PATCH',
    headers: admin,
    body: body({ note: `${prefix}模板备注` }),
  })
  const templateItem = await request<Row>(
    '/manufacturing/process-template-items',
    {
      method: 'POST',
      headers: admin,
      body: body({
        templateId: template.id,
        operationId: operation.id,
        seq: 10,
        requirement: '模板原值',
        isOutsourced: true,
      }),
    },
    201,
  )
  await request<Row>(
    `/manufacturing/process-template-items/${templateItem.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ requirement: '模板复制前', seq: 10 }),
    },
  )
  const templateItems = await query<Row>(
    '/manufacturing/process-template-items',
    admin,
    { templateId: fk(template.id) },
  )
  assert(
    templateItems.results.some((row) => row.id === templateItem.id),
    '工艺模板行 query 失败',
  )
  assert(
    (
      await request<Row>(
        `/manufacturing/process-template-items/${templateItem.id}`,
        { headers: admin },
      )
    ).id === templateItem.id,
    '工艺模板行 get 失败',
  )
  assert(
    (
      await request<Row>(`/manufacturing/process-templates/${template.id}`, {
        headers: admin,
      })
    ).id === template.id,
    '工艺模板 get 失败',
  )

  const bom = await request<Row>(
    '/manufacturing/boms',
    {
      method: 'POST',
      headers: admin,
      body: body({
        code: `${prefix}BOM`,
        materialId: fixture.materialId,
        planName: `${prefix}内制`,
      }),
    },
    201,
  )
  await request<Row>(`/manufacturing/boms/${bom.id}`, {
    method: 'PATCH',
    headers: admin,
    body: body({ note: `${prefix}BOM备注` }),
  })
  assert(
    (await request<Row>(`/manufacturing/boms/${bom.id}`, { headers: admin }))
      .id === bom.id,
    'BOM get 失败',
  )
  const component = await request<Row>(
    '/manufacturing/bom-components',
    {
      method: 'POST',
      headers: admin,
      body: body({
        bomId: bom.id,
        materialId: fixture.componentId,
        unitId: fixture.unitId,
        quantity: '2.5',
        lossRate: '0.1',
      }),
    },
    201,
  )
  const changedComponent = await request<Row>(
    `/manufacturing/bom-components/${component.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ quantity: '3', note: `${prefix}配料备注` }),
    },
  )
  assert(
    changedComponent.quantity === '3' && changedComponent.lossRate === '0.1',
    'BOM 配料 Decimal/update 错误',
  )
  assert(
    (
      await request<Row>(`/manufacturing/bom-components/${component.id}`, {
        headers: admin,
      })
    ).id === component.id,
    'BOM 配料 get 失败',
  )
  const byproduct = await request<Row>(
    '/manufacturing/bom-byproducts',
    {
      method: 'POST',
      headers: admin,
      body: body({
        bomId: bom.id,
        materialId: fixture.componentId,
        unitId: fixture.unitId,
        quantity: '0.2',
      }),
    },
    201,
  )
  await request<Row>(`/manufacturing/bom-byproducts/${byproduct.id}`, {
    method: 'PATCH',
    headers: admin,
    body: body({ quantity: '0.25', note: `${prefix}副产物` }),
  })
  assert(
    (
      await request<Row>(`/manufacturing/bom-byproducts/${byproduct.id}`, {
        headers: admin,
      })
    ).id === byproduct.id,
    'BOM 副产品 get 失败',
  )

  await request<Row>(`/manufacturing/boms/${bom.id}/apply-route-template`, {
    method: 'POST',
    headers: admin,
    body: body({ templateId: template.id }),
  })
  const copiedBefore = await query<Row>('/manufacturing/bom-routes', admin, {
    bomId: fk(bom.id),
  })
  assert(
    copiedBefore.count === 1 &&
      copiedBefore.results[0]?.seq === 10 &&
      copiedBefore.results[0]?.requirement === '模板复制前',
    'BOM 模板路线复制失败',
  )
  await request<Row>(
    `/manufacturing/process-template-items/${templateItem.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ seq: 99, requirement: '模板后改' }),
    },
  )
  const copiedAfter = await request<Row>(
    `/manufacturing/bom-routes/${copiedBefore.results[0]!.id}`,
    { headers: admin },
  )
  assert(
    copiedAfter.seq === 10 && copiedAfter.requirement === '模板复制前',
    'BOM 路线不是脱离模板的快照',
  )
  await requestText(
    `/manufacturing/boms/${bom.id}/apply-route-template`,
    {
      method: 'POST',
      headers: admin,
      body: body({ templateId: template.id }),
    },
    409,
  )
  const directRoute = await request<Row>(
    '/manufacturing/bom-routes',
    {
      method: 'POST',
      headers: admin,
      body: body({
        bomId: bom.id,
        operationId: operation.id,
        seq: 20,
        requirement: `${prefix}直接路线`,
        isOutsourced: false,
      }),
    },
    201,
  )
  const changedRoute = await request<Row>(
    `/manufacturing/bom-routes/${directRoute.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ seq: 30, requirement: `${prefix}直接路线已改` }),
    },
  )
  assert(changedRoute.seq === 30, 'BOM 路线 update 失败')
  assert(
    (
      await request<Row>(`/manufacturing/bom-routes/${directRoute.id}`, {
        headers: admin,
      })
    ).id === directRoute.id,
    'BOM 路线 get 失败',
  )
  await requestText(
    `/manufacturing/bom-routes/${directRoute.id}`,
    { method: 'DELETE', headers: admin },
    204,
  )

  const globalOps = await query<Row>('/manufacturing/operations', readOnly)
  const globalTemplates = await query<Row>(
    '/manufacturing/process-templates',
    readOnly,
  )
  const globalBoms = await query<Row>('/manufacturing/boms', readOnly)
  assert(
    globalOps.results.some((row) => row.id === operation.id) &&
      globalTemplates.results.some((row) => row.id === template.id) &&
      globalBoms.results.some((row) => row.id === bom.id),
    '全局制造主数据不应受公司范围裁剪',
  )

  const otherDemand = await request<Demand>(
    '/manufacturing/demands',
    {
      method: 'POST',
      headers: admin,
      body: body({
        companyId: fixture.otherCompanyId,
        demandNo: `${prefix}-D-OUTSIDE`,
      }),
    },
    201,
  )
  const otherOutput = await request<Output>(
    '/manufacturing/outputs',
    {
      method: 'POST',
      headers: admin,
      body: body({
        companyId: fixture.otherCompanyId,
        outputNo: `${prefix}-O-OUTSIDE`,
      }),
    },
    201,
  )
  const scopedDemands = await query<Demand>('/manufacturing/demands', readOnly)
  const scopedOutputs = await query<Output>('/manufacturing/outputs', readOnly)
  assert(
    !scopedDemands.results.some((row) => row.id === otherDemand.id) &&
      !scopedOutputs.results.some((row) => row.id === otherOutput.id),
    '公司范围未裁剪域外制造单据',
  )
  for (const path of [
    `/manufacturing/demands/${otherDemand.id}`,
    `/manufacturing/outputs/${otherOutput.id}`,
  ]) {
    const response = await rawRequest(path, { headers: readOnly })
    assert(
      response.status === 403 || response.status === 404,
      `域外记录 get 应 fail closed：${path} ${response.status}`,
    )
    await response.body?.cancel()
  }

  const first = await createDemand(
    admin,
    fixture,
    'RACE1',
    'MAKE',
    '8',
    fixture.salesOrderItemId,
  )
  const second = await createDemand(
    admin,
    fixture,
    'RACE2',
    'MAKE',
    '8',
    fixture.salesOrderItemId,
  )
  const confirmResponses = await Promise.all([
    rawRequest(`/manufacturing/demands/${first.demand.id}/confirm`, {
      method: 'POST',
      headers: admin,
    }),
    rawRequest(`/manufacturing/demands/${second.demand.id}/confirm`, {
      method: 'POST',
      headers: admin,
    }),
  ])
  const confirmStatuses = confirmResponses
    .map((response) => response.status)
    .sort()
  await Promise.all(confirmResponses.map((response) => response.body?.cancel()))
  same(confirmStatuses, [200, 409], '双需求并发确认')

  const confirmedRows = await db`
    SELECT d.id::text AS demand_id,i.id::text AS item_id
    FROM mfg_demand d
    JOIN mfg_demand_item i ON i.demand_id=d.id
    WHERE i.sales_order_item_id=${fixture.salesOrderItemId}::uuid
      AND d.status='confirmed'
  `
  assert(confirmedRows.length === 1, '并发确认后应只有一张需求占用销售行')
  const confirmedDemandId = String(confirmedRows[0]!.demand_id)
  const confirmedItemId = String(confirmedRows[0]!.item_id)
  const occupancies = await request<{ results: Occupancy[] }>(
    '/manufacturing/sales-item-occupancies',
    {
      method: 'POST',
      headers: admin,
      body: body({ salesOrderItemIds: [fixture.salesOrderItemId] }),
    },
  )
  assert(
    occupancies.results.length === 1 &&
      occupancies.results[0]!.orderedBaseQty === '10' &&
      occupancies.results[0]!.occupiedBaseQty === '8' &&
      occupancies.results[0]!.remainingBaseQty === '2',
    `销售占用错误：${JSON.stringify(occupancies)}`,
  )

  const workOrderResponses = await Promise.all(
    ['A', 'B'].map((mark) =>
      rawRequest('/manufacturing/work-orders', {
        method: 'POST',
        headers: admin,
        body: body({
          demandItemId: confirmedItemId,
          workOrderNo: `${prefix}-WO-${mark}`,
        }),
      }),
    ),
  )
  const workStatuses = workOrderResponses
    .map((response) => response.status)
    .sort()
  same(workStatuses, [201, 409], '同需求行并发生成工单')
  let workOrder: WorkOrder | null = null
  for (const response of workOrderResponses) {
    const text = await response.text()
    if (response.status === 201) workOrder = JSON.parse(text) as WorkOrder
  }
  assert(workOrder, '并发生成工单无成功结果')
  workOrder = await request<WorkOrder>(
    `/manufacturing/work-orders/${workOrder.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ workOrderNo: `${prefix}-WO-MAIN` }),
    },
  )
  assert(
    workOrder.workOrderNo === `${prefix}-WO-MAIN` &&
      (
        await request<WorkOrder>(`/manufacturing/work-orders/${workOrder.id}`, {
          headers: admin,
        })
      ).id === workOrder.id,
    '生产工单 get/update 失败',
  )
  const scheduledItem = await request<DemandItem>(
    `/manufacturing/demand-items/${confirmedItemId}`,
    { headers: admin },
  )
  assert(scheduledItem.status === 'SCHEDULED', '生成工单未回写需求行已安排')

  const tempDemand = await createDemand(admin, fixture, 'CRUD', 'BUY', '2')
  const changedDemand = await request<Demand>(
    `/manufacturing/demands/${tempDemand.demand.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ remarks: `${prefix}需求头已改` }),
    },
  )
  assert(changedDemand.remarks === `${prefix}需求头已改`, '需求头 update 失败')
  const changedDemandItem = await request<DemandItem>(
    `/manufacturing/demand-items/${tempDemand.item.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ qty: '3', remarks: `${prefix}行已改` }),
    },
  )
  assert(
    changedDemandItem.qty === '3' && changedDemandItem.baseQty === '3',
    '需求行 CRUD/折算错误',
  )
  const demandItems = await query<DemandItem>(
    '/manufacturing/demand-items',
    admin,
    { demandId: fk(tempDemand.demand.id) },
    { column: 'idx', direction: 'ascending' },
  )
  assert(
    demandItems.results[0]?.id === tempDemand.item.id,
    '需求行 query/get 失败',
  )
  await requestText(
    `/manufacturing/demand-items/${tempDemand.item.id}`,
    { method: 'DELETE', headers: admin },
    204,
  )
  await requestText(
    `/manufacturing/demands/${tempDemand.demand.id}`,
    { method: 'DELETE', headers: admin },
    204,
  )

  const actionsDemand = await request<Demand>(
    '/manufacturing/demands',
    {
      method: 'POST',
      headers: admin,
      body: body({
        companyId: fixture.companyId,
        demandNo: `${prefix}-D-ACTIONS`,
      }),
    },
    201,
  )
  const completeItem = await request<DemandItem>(
    '/manufacturing/demand-items',
    {
      method: 'POST',
      headers: admin,
      body: body({
        demandId: actionsDemand.id,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        idx: 1,
        qty: '1',
        fulfillmentMethod: 'STOCK',
      }),
    },
    201,
  )
  const changeItem = await request<DemandItem>(
    '/manufacturing/demand-items',
    {
      method: 'POST',
      headers: admin,
      body: body({
        demandId: actionsDemand.id,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        idx: 2,
        qty: '1',
        fulfillmentMethod: 'BUY',
      }),
    },
    201,
  )
  await request<Demand>(`/manufacturing/demands/${actionsDemand.id}/confirm`, {
    method: 'POST',
    headers: admin,
  })
  const completed = await request<DemandItem>(
    `/manufacturing/demand-items/${completeItem.id}/complete`,
    { method: 'POST', headers: admin },
  )
  const changedMethod = await request<DemandItem>(
    `/manufacturing/demand-items/${changeItem.id}/fulfillment`,
    {
      method: 'POST',
      headers: admin,
      body: body({ fulfillmentMethod: 'OUTSOURCE' }),
    },
  )
  assert(
    completed.status === 'COMPLETED' &&
      changedMethod.fulfillmentMethod === 'OUTSOURCE',
    '需求行 complete/change fulfillment 失败',
  )
  const closed = await request<Demand>(
    `/manufacturing/demands/${actionsDemand.id}/close`,
    { method: 'POST', headers: admin },
  )
  assert(closed.status === 'CLOSED', '需求 close 失败')

  const voidable = await createDemand(admin, fixture, 'VOID', 'STOCK', '1')
  await request<Demand>(
    `/manufacturing/demands/${voidable.demand.id}/confirm`,
    { method: 'POST', headers: admin },
  )
  const voidedDemand = await request<Demand>(
    `/manufacturing/demands/${voidable.demand.id}/void`,
    { method: 'POST', headers: admin },
  )
  assert(voidedDemand.status === 'VOIDED', '需求 void 失败')

  const output = await request<Output>(
    '/manufacturing/outputs',
    {
      method: 'POST',
      headers: admin,
      body: body({
        companyId: fixture.companyId,
        outputNo: `${prefix}-OUT`,
        outputDate: '2026-07-26',
        warehouseId: fixture.warehouseId,
      }),
    },
    201,
  )
  const outputItem = await request<Row>(
    '/manufacturing/output-items',
    {
      method: 'POST',
      headers: admin,
      body: body({
        outputId: output.id,
        workOrderId: workOrder.id,
        unitId: fixture.unitId,
        warehouseId: fixture.warehouseId,
        idx: 1,
        qty: '6',
      }),
    },
    201,
  )
  const changedOutputItem = await request<Row>(
    `/manufacturing/output-items/${outputItem.id}`,
    {
      method: 'PATCH',
      headers: admin,
      body: body({ qty: '6', remarks: `${prefix}入库行` }),
    },
  )
  assert(
    changedOutputItem.baseQty === '6',
    '生产入库行 update/Decimal 折算失败',
  )
  const outputItems = await query<Row>(
    '/manufacturing/output-items',
    admin,
    { outputId: fk(output.id) },
    { column: 'idx', direction: 'ascending' },
  )
  assert(
    outputItems.results[0]?.id === outputItem.id,
    '生产入库行 query/get 失败',
  )
  await concurrentStatuses(
    `/manufacturing/outputs/${output.id}/audit`,
    { method: 'POST', headers: admin },
    [200, 409],
  )
  const audited = await request<Output>(`/manufacturing/outputs/${output.id}`, {
    headers: admin,
  })
  assert(
    audited.status === 'AUDITED' && typeof audited.auditedAt === 'string',
    '生产入库 audit 状态/审计人时间错误',
  )
  const projectionAfterAudit = await db`
    SELECT w.received_base_qty::text AS received,
           w.status AS work_status,
           i.status AS item_status,
           (SELECT coalesce(sum(quantity),0)::text
              FROM inv_stock_entry
             WHERE voucher_type='mfg.output'
               AND voucher_id=${output.id}::uuid
               AND is_cancelled=false) AS stock,
           (SELECT count(*)::text FROM sys_audit_log
             WHERE record_id=${output.id}::uuid) AS audits
    FROM mfg_work_order w
    JOIN mfg_demand_item i ON i.id=w.demand_item_id
    WHERE w.id=${workOrder.id}::uuid
  `
  assert(
    projectionAfterAudit[0]?.received === '6' &&
      projectionAfterAudit[0]?.work_status === 'in_progress' &&
      projectionAfterAudit[0]?.item_status === 'scheduled' &&
      projectionAfterAudit[0]?.stock === '6' &&
      Number(projectionAfterAudit[0]?.audits) > 0,
    `生产入库库存/投影/audit log 错误：${JSON.stringify(projectionAfterAudit)}`,
  )
  const voidedOutput = await request<Output>(
    `/manufacturing/outputs/${output.id}/void`,
    { method: 'POST', headers: admin },
  )
  assert(voidedOutput.status === 'VOIDED', '生产入库 void 失败')
  const projectionAfterVoid = await db`
    SELECT w.received_base_qty::text AS received,
           w.status AS work_status,
           i.status AS item_status,
           (SELECT count(*)::text FROM inv_stock_entry
             WHERE voucher_type='mfg.output'
               AND voucher_id=${output.id}::uuid
               AND is_cancelled=false) AS active_stock,
           (SELECT count(*)::text FROM inv_stock_entry
             WHERE voucher_type='mfg.output'
               AND voucher_id=${output.id}::uuid
               AND is_cancelled=true) AS cancelled_stock
    FROM mfg_work_order w
    JOIN mfg_demand_item i ON i.id=w.demand_item_id
    WHERE w.id=${workOrder.id}::uuid
  `
  assert(
    projectionAfterVoid[0]?.received === '0' &&
      projectionAfterVoid[0]?.work_status === 'in_progress' &&
      projectionAfterVoid[0]?.item_status === 'scheduled' &&
      projectionAfterVoid[0]?.active_stock === '0' &&
      Number(projectionAfterVoid[0]?.cancelled_stock) > 0,
    `生产入库作废未原路回滚：${JSON.stringify(projectionAfterVoid)}`,
  )

  const voidedWorkOrder = await request<WorkOrder>(
    `/manufacturing/work-orders/${workOrder.id}/void`,
    { method: 'POST', headers: admin },
  )
  assert(voidedWorkOrder.status === 'VOIDED', '工单 void 失败')
  await requestText(
    `/manufacturing/work-orders/${workOrder.id}`,
    { method: 'DELETE', headers: admin },
    409,
  )
  const releasedItem = await request<DemandItem>(
    `/manufacturing/demand-items/${confirmedItemId}`,
    { headers: admin },
  )
  assert(releasedItem.status === 'PENDING', '工单作废/删除未回退需求行')
  const releasedDemand = await request<Demand>(
    `/manufacturing/demands/${confirmedDemandId}/void`,
    { method: 'POST', headers: admin },
  )
  assert(releasedDemand.status === 'VOIDED', '工单清除后需求应可作废')

  const draftOutput = await request<Output>(
    '/manufacturing/outputs',
    {
      method: 'POST',
      headers: admin,
      body: body({
        companyId: fixture.companyId,
        outputNo: `${prefix}-OUT-DELETE`,
      }),
    },
    201,
  )
  await request<Output>(`/manufacturing/outputs/${draftOutput.id}`, {
    method: 'PATCH',
    headers: admin,
    body: body({ remarks: `${prefix}待删` }),
  })
  assert(
    (
      await request<Output>(`/manufacturing/outputs/${draftOutput.id}`, {
        headers: admin,
      })
    ).id === draftOutput.id,
    '生产入库头 get/update 失败',
  )
  await requestText(
    `/manufacturing/outputs/${draftOutput.id}`,
    { method: 'DELETE', headers: admin },
    204,
  )

  const masterQueries = await Promise.all([
    query<Row>('/manufacturing/operations', admin),
    query<Row>('/manufacturing/process-templates', admin),
    query<Row>('/manufacturing/boms', admin),
    query<Row>('/manufacturing/bom-components', admin, {
      bomId: fk(bom.id),
    }),
    query<Row>('/manufacturing/bom-routes', admin, { bomId: fk(bom.id) }),
    query<Row>('/manufacturing/bom-byproducts', admin, {
      bomId: fk(bom.id),
    }),
    query<Demand>('/manufacturing/demands', admin, {
      companyId: fk(fixture.companyId),
    }),
    query<DemandItem>('/manufacturing/demand-items', admin, {
      companyId: fk(fixture.companyId),
    }),
    query<WorkOrder>('/manufacturing/work-orders', admin, {
      companyId: fk(fixture.companyId),
    }),
    query<Output>('/manufacturing/outputs', admin, {
      companyId: fk(fixture.companyId),
    }),
    query<Row>('/manufacturing/output-items', admin, {
      companyId: fk(fixture.companyId),
    }),
  ])
  assert(
    masterQueries.every(
      (result) =>
        typeof result.count === 'number' && Array.isArray(result.results),
    ),
    '制造 list/query 表面不是 {count,results}',
  )
  for (const path of [
    `/manufacturing/bom-components/${component.id}`,
    `/manufacturing/bom-byproducts/${byproduct.id}`,
    `/manufacturing/bom-routes/${copiedBefore.results[0]!.id}`,
    `/manufacturing/boms/${bom.id}`,
    `/manufacturing/process-template-items/${templateItem.id}`,
    `/manufacturing/process-templates/${template.id}`,
    `/manufacturing/operations/${operation.id}`,
  ]) {
    await requestText(path, { method: 'DELETE', headers: admin }, 204)
  }

  assert(graphqlCalls === 0, `REST 验收不得调用 GraphQL，实际 ${graphqlCalls}`)
  acceptanceSummary =
    `manufacturing REST acceptance ok: meta=24 permissionFirst=${permissionFirst} ` +
    `parentPermissions=${parentPermissionChecks} global=3 scoped=2 crud=12 ` +
    `demandActions=5 salesOccupancy=1 concurrentConfirm=1 concurrentWorkOrder=1 ` +
    `outputAuditVoid=2 concurrentAudit=1 stockProjectionRollback=1 graphql=${graphqlCalls}`
} finally {
  await cleanup(fixture)
}

assert(cleanupCount === 0, `制造验收夹具清理残留 ${cleanupCount}`)
console.log(`${acceptanceSummary} cleanup=${cleanupCount}`)
