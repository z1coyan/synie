/**
 * 下发车间场景端到端（工单 07，spec §2 试点场景即验收基准）。
 *
 * 角色：计划员（全套 scope=all，无部门）× 冲压车间生产经理
 * （`mfg.demand:read` scope=dept + 工单全套 scope=dept，用户挂冲压车间）。
 * 断言口径：动作码不满足 403 forbidden；行级范围不命中 404 not_found / 列表不含；
 * 状态不满足 409 conflict（状态守卫划出权限系统）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

/** 计划员：需求单/工单全套 + 部门可读（下发时要选车间） */
const PLANNER_CODES = [
  'mfg.demand:read',
  'mfg.demand:create',
  'mfg.demand:update',
  'mfg.demand:delete',
  'mfg.demand:confirm',
  'mfg.demand:close',
  'mfg.demand:void',
  'mfg.demand:dispatch',
  'mfg.work_order:read',
  'mfg.work_order:create',
  'mfg.work_order:update',
  'mfg.work_order:void',
  'sys.department:read',
] as const

/** 车间经理：需求单只读（本部门），工单全套（本部门）；无 dispatch */
const SHOP_CODES = [
  'mfg.demand:read',
  'mfg.work_order:read',
  'mfg.work_order:create',
  'mfg.work_order:update',
  'mfg.work_order:void',
] as const

run('PG 集成（需求单下发车间：assigned/stamped 两形态）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  /** 建用户走 IamService：superAdmin 现取一张 sysUsers:create 凭证 */
  const adminUserPermit = () => {
    const decision = authz.decideFor(admin, 'sysUsers', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const stampDeptId = crypto.randomUUID()
  const assemblyDeptId = crypto.randomUUID()
  const otherCompanyDeptId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const plannerRoleId = crypto.randomUUID()
  const shopRoleId = crypto.randomUUID()

  let plannerId = ''
  let shopId = ''
  let plannerHeaders: Record<string, string> = {}
  let shopHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  const createdDemands: string[] = []
  const createdWorkOrders: string[] = []

  /** 覆盖式授权（role, code, scope）三元组；矩阵范围 UI 未到位前直接写授权表 */
  async function grant(
    roleId: string,
    codes: readonly string[],
    scope: 'all' | 'dept' | 'dept_tree' | 'self',
  ): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope })))
        .execute()
    }
  }

  async function login(username: string, password: string): Promise<Record<string, string>> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const { token } = (await res.json()) as { token: string }
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  }

  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1/manufacturing${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  const patch = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1/manufacturing${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1/manufacturing${path}`, { headers })

  interface DemandDto {
    id: string
    demandNo: string
    status: string
    assignedDeptId: string | null
  }
  interface WorkOrderDto {
    id: string
    workOrderNo: string
    ownerDeptId: string | null
  }

  /** 建一张需求单（含一行）；返回头与行 id */
  async function seedDemand(
    no: string,
    assignedDeptId: string | null,
  ): Promise<{ demand: DemandDto; itemId: string }> {
    const created = await post('/demands', plannerHeaders, {
      companyId,
      demandNo: no,
      ...(assignedDeptId ? { assignedDeptId } : {}),
    })
    expect(created.status).toBe(201)
    const demand = (await created.json()) as DemandDto
    createdDemands.push(demand.id)
    const item = await post('/demand-items', plannerHeaders, {
      demandId: demand.id,
      idx: 1,
      materialId,
      unitId,
      qty: '10',
    })
    expect(item.status).toBe(201)
    const { id: itemId } = (await item.json()) as { id: string }
    return { demand, itemId }
  }

  async function confirmAndDispatch(demandId: string, deptId: string): Promise<DemandDto> {
    expect((await post(`/demands/${demandId}/confirm`, plannerHeaders, {})).status).toBe(200)
    const res = await post(`/demands/${demandId}/dispatch`, plannerHeaders, {
      assignedDeptId: deptId,
    })
    expect(res.status).toBe(200)
    return (await res.json()) as DemandDto
  }

  async function demandIds(headers: Record<string, string>): Promise<string[]> {
    const res = await post('/demands/query', headers, { limit: 100, offset: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: DemandDto[] }
    return body.results.map((r) => r.id)
  }

  async function workOrderIds(headers: Record<string, string>): Promise<string[]> {
    const res = await post('/work-orders/query', headers, { limit: 100, offset: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: WorkOrderDto[] }
    return body.results.map((r) => r.id)
  }

  let stampDemand: DemandDto
  let stampItemId = ''
  let assemblyDemand: DemandDto
  let assemblyItemId = ''
  let draftDemandId = ''

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'下发币-' + suffix}, ${'D' + suffix.slice(0, 2).toUpperCase()}, 'D', true)
    `.execute(db)
    for (const [id, code, name] of [
      [companyId, 'DP', '下发公司'],
      [otherCompanyId, 'DQ', '外部公司'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${name + suffix}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    for (const [id, company, code, name] of [
      [stampDeptId, companyId, 'STAMP', '冲压车间'],
      [assemblyDeptId, companyId, 'ASSY', '装配车间'],
      [otherCompanyDeptId, otherCompanyId, 'FOREIGN', '外部车间'],
    ] as const) {
      await sql`
        INSERT INTO sys_department (id, company_id, code, name, path)
        VALUES (${id}::uuid, ${company}::uuid, ${code + suffix}, ${name}, ${'/' + id + '/'})
      `.execute(db)
    }
    await db
      .insertInto('bas_unit')
      .values({
        id: unitId,
        unit_type: 'quantity',
        is_base: false,
        name: `下发单位-${suffix}`,
        symbol: `d${suffix.slice(0, 5)}`,
        ratio: '1',
      })
      .execute()
    await db
      .insertInto('inv_material_category')
      .values({
        id: categoryId,
        code: `DC${suffix}`,
        name: `下发分类-${suffix}`,
        is_leaf: true,
        active: true,
      })
      .execute()
    await db
      .insertInto('inv_material')
      .values({
        id: materialId,
        code: `DM${suffix}`,
        name: `下发成品-${suffix}`,
        category_id: categoryId,
        default_unit_id: unitId,
      })
      .execute()
    await db
      .insertInto('sys_role')
      .values([
        { id: plannerRoleId, code: `planner-${suffix}`, name: `计划员-${suffix}` },
        { id: shopRoleId, code: `shop-${suffix}`, name: `冲压车间经理-${suffix}` },
      ])
      .execute()

    const planner = await iam.createUser(adminUserPermit(), {
      username: `planner-${suffix}`,
      name: '计划员',
      roleIds: [plannerRoleId],
      companyIds: [companyId],
    })
    plannerId = planner.user.id
    const shop = await iam.createUser(adminUserPermit(), {
      username: `shop-${suffix}`,
      name: '冲压车间经理',
      departmentId: stampDeptId,
      roleIds: [shopRoleId],
      companyIds: [companyId],
    })
    shopId = shop.user.id

    await grant(plannerRoleId, PLANNER_CODES, 'all')
    await grant(shopRoleId, SHOP_CODES, 'dept')

    app = await buildTestApp(db, { registry })
    plannerHeaders = await login(planner.user.username, planner.password)
    shopHeaders = await login(shop.user.username, shop.password)

    const stamp = await seedDemand(`DS1-${suffix}`, null)
    stampItemId = stamp.itemId
    stampDemand = await confirmAndDispatch(stamp.demand.id, stampDeptId)

    const assembly = await seedDemand(`DS2-${suffix}`, null)
    assemblyItemId = assembly.itemId
    assemblyDemand = await confirmAndDispatch(assembly.demand.id, assemblyDeptId)

    // 草稿未下发单（改派动线与不可见集合都靠它）
    const draft = await seedDemand(`DS3-${suffix}`, null)
    draftDemandId = draft.demand.id
  })

  afterAll(async () => {
    for (const id of createdWorkOrders) {
      await sql`DELETE FROM sys_audit_log WHERE record_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM sys_attachment WHERE owner_type = 'mfg_work_order' AND owner_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_demand_arrangement WHERE work_order_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_work_order WHERE id = ${id}::uuid`.execute(db)
    }
    for (const id of createdDemands) {
      await sql`
        DELETE FROM sys_audit_log
        WHERE record_id = ${id}::uuid
           OR record_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`
        DELETE FROM mfg_demand_arrangement
        WHERE demand_item_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${id}::uuid)
      `.execute(db)
      await sql`DELETE FROM mfg_demand_item WHERE demand_id = ${id}::uuid`.execute(db)
      await sql`DELETE FROM mfg_demand WHERE id = ${id}::uuid`.execute(db)
    }
    await sql`DELETE FROM inv_material WHERE id = ${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id = ${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id = ${unitId}::uuid`.execute(db)
    for (const userId of [plannerId, shopId]) {
      if (!userId) continue
      await sql`DELETE FROM sys_audit_log WHERE actor_id = ${userId}::uuid`.execute(db)
      await db.deleteFrom('sys_user_role').where('user_id', '=', userId).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', userId).execute()
      await sql`DELETE FROM auth_account WHERE user_id IN (SELECT auth_user_id FROM sys_user WHERE id = ${userId}::uuid)`.execute(db)
      await db.deleteFrom('sys_user').where('id', '=', userId).execute()
    }
    for (const roleId of [plannerRoleId, shopRoleId]) {
      await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
      await db.deleteFrom('sys_role').where('id', '=', roleId).execute()
    }
    await sql`DELETE FROM sys_department WHERE id = ANY(${[stampDeptId, assemblyDeptId, otherCompanyDeptId]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_company WHERE id = ANY(${[companyId, otherCompanyId]}::uuid[])`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('计划员下发/改派：写审计，指派列不受操作者部门约束（计划员本身无部门）', async () => {
    expect(stampDemand.assignedDeptId).toBe(stampDeptId)
    expect(assemblyDemand.assignedDeptId).toBe(assemblyDeptId)

    // 改派到装配再改回冲压：两次都留审计
    const reassigned = await post(`/demands/${stampDemand.id}/dispatch`, plannerHeaders, {
      assignedDeptId: assemblyDeptId,
    })
    expect(reassigned.status).toBe(200)
    expect(((await reassigned.json()) as DemandDto).assignedDeptId).toBe(assemblyDeptId)
    const back = await post(`/demands/${stampDemand.id}/dispatch`, plannerHeaders, {
      assignedDeptId: stampDeptId,
    })
    expect(back.status).toBe(200)

    const audit = await sql<{ count: string; changes: string }>`
      SELECT count(*)::text AS count, max(changes::text) AS changes
      FROM sys_audit_log
      WHERE record_id = ${stampDemand.id}::uuid AND action_name = 'dispatch'
    `.execute(db)
    expect(Number(audit.rows[0]?.count)).toBe(3)
    expect(String(audit.rows[0]?.changes)).toContain('assigned_dept_id')
  })

  test('dispatch 的状态守卫与同公司硬校验', async () => {
    // 草稿态改派只能走表单（状态守卫是领域不变量，不是权限）
    const draft = await post(`/demands/${draftDemandId}/dispatch`, plannerHeaders, {
      assignedDeptId: stampDeptId,
    })
    expect(draft.status).toBe(409)

    // 跨公司车间：validation（不是 not_found——指派列是业务字段，同公司是参数约束）
    const foreign = await post(`/demands/${stampDemand.id}/dispatch`, plannerHeaders, {
      assignedDeptId: otherCompanyDeptId,
    })
    expect(foreign.status).toBe(400)
    expect((await foreign.json()) as { error: { fields?: Record<string, string[]> } }).toMatchObject(
      { error: { fields: { assignedDeptId: ['车间必须属于需求单所在公司'] } } },
    )
  })

  test('草稿态表单可填可改下发车间（create 与 patch 两条路径）', async () => {
    const withDept = await seedDemand(`DS4-${suffix}`, stampDeptId)
    expect(withDept.demand.assignedDeptId).toBe(stampDeptId)
    // 草稿可见于车间（行谓词只看指派列，不看状态）
    expect(await demandIds(shopHeaders)).toContain(withDept.demand.id)

    const cleared = await patch(`/demands/${withDept.demand.id}`, plannerHeaders, {
      assignedDeptId: null,
    })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as DemandDto).assignedDeptId).toBeNull()
    expect(await demandIds(shopHeaders)).not.toContain(withDept.demand.id)
  })

  test('需求行随母单可达（via 链把 dept 谓词递归到母单的指派列）', async () => {
    const res = await post('/demand-items/query', shopHeaders, { limit: 100, offset: 0 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { id: string; demandId: string }[] }
    const demandIdsOfItems = new Set(body.results.map((r) => r.demandId))
    expect(demandIdsOfItems).toEqual(new Set([stampDemand.id]))
    expect((await get(`/demand-items/${assemblyItemId}`, shopHeaders)).status).toBe(404)
    expect((await get(`/demand-items/${stampItemId}`, shopHeaders)).status).toBe(200)
  })

  test('车间经理只见下发本车间的需求单；他车间与未下发单一律 not_found', async () => {
    const visible = await demandIds(shopHeaders)
    expect(visible).toContain(stampDemand.id)
    expect(visible).not.toContain(assemblyDemand.id)
    expect(visible).not.toContain(draftDemandId)

    expect((await get(`/demands/${stampDemand.id}`, shopHeaders)).status).toBe(200)
    expect((await get(`/demands/${assemblyDemand.id}`, shopHeaders)).status).toBe(404)
    expect((await get(`/demands/${draftDemandId}`, shopHeaders)).status).toBe(404)

    // 计划员 scope=all：三张都在
    const all = await demandIds(plannerHeaders)
    expect(all).toContain(stampDemand.id)
    expect(all).toContain(assemblyDemand.id)
    expect(all).toContain(draftDemandId)
  })

  test('车间经理无 dispatch 码 → forbidden（码级判定先于行级）', async () => {
    const res = await post(`/demands/${stampDemand.id}/dispatch`, shopHeaders, {
      assignedDeptId: assemblyDeptId,
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'forbidden' },
    })
  })

  test('车间经理从下发到本车间的需求行建工单：归属部门盖章为本部门', async () => {
    const res = await post('/work-orders', shopHeaders, {
      demandItemId: stampItemId,
      workOrderNo: `WOS-${suffix}`,
    })
    expect(res.status).toBe(201)
    const wo = (await res.json()) as WorkOrderDto
    createdWorkOrders.push(wo.id)
    expect(wo.ownerDeptId).toBe(stampDeptId)
    expect(await workOrderIds(shopHeaders)).toContain(wo.id)
  })

  test('他车间的需求行不可达 → 建工单 not_found（不泄露需求行存在性）', async () => {
    const res = await post('/work-orders', shopHeaders, {
      demandItemId: assemblyItemId,
      workOrderNo: `WOX-${suffix}`,
    })
    expect(res.status).toBe(404)
  })

  test('无部门用户建的工单盖 NULL：仅 all 范围可见', async () => {
    const res = await post('/work-orders', plannerHeaders, {
      demandItemId: assemblyItemId,
      workOrderNo: `WOP-${suffix}`,
    })
    expect(res.status).toBe(201)
    const wo = (await res.json()) as WorkOrderDto
    createdWorkOrders.push(wo.id)
    expect(wo.ownerDeptId).toBeNull()

    expect(await workOrderIds(plannerHeaders)).toContain(wo.id)
    expect(await workOrderIds(shopHeaders)).not.toContain(wo.id)
    expect((await get(`/work-orders/${wo.id}`, shopHeaders)).status).toBe(404)
  })
})
