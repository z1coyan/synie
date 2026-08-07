/**
 * 扫荡批 5（工单 11）的授权端到端验收：inventory 余量 / manufacturing 余量。
 *
 * 断言口径（错误语义唯一规则）：动作码不满足 403 forbidden；行级范围不命中
 * 404 not_found / 列表不含；状态不满足 409 conflict（状态守卫划出权限系统）。
 *
 * 本批只有仓库（inv_warehouse）是 **company** 形态，跨公司 404 在它上验；
 * 物料/分类/工序/工艺模板/BOM/模具设计都是 **global**（无公司列），
 * 对应断言是「矩阵对该前缀无行级范围」（supportedScopes 只有 all）。
 * 单位转换与 BOM/模板子行是 **via**：单条读经 EXISTS 递归归宿，自身不拥有范围。
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

/** 全量角色：本批各资源的读 + 仓库/分类写（够跑完别名回归、404、409） */
const FULL_CODES = [
  'base.material_category:read',
  'base.material_category:create',
  'base.material_category:delete',
  'base.material:read',
  'base.warehouse:read',
  'base.warehouse:create',
  'base.warehouse:update',
  'base.warehouse:delete',
  'mfg.operation:read',
  'mfg.route_template:read',
  'mfg.bom:read',
  'mfg.mold_design:read',
  'mfg.mold_design:create',
] as const

/** 只读角色：故意不含任何写码（缺码 403 用例） */
const READ_ONLY_CODES = FULL_CODES.filter((c) => c.endsWith(':read'))

run('PG 集成（扫荡 11：inventory/manufacturing 余量授权语义）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  const adminUserPermit = () => {
    const decision = authz.decideFor(admin, 'sysUsers', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  // 分类：父（含子，删除 409 用例）+ 叶（挂物料）
  const categoryRoot = crypto.randomUUID()
  const categoryLeaf = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const materialUnitId = crypto.randomUUID()
  const unitAltId = crypto.randomUUID()
  const warehouseRootA = crypto.randomUUID()
  const warehouseOutsourcedA = crypto.randomUUID()
  const warehouseB = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const operationId = crypto.randomUUID()
  const templateId = crypto.randomUUID()
  const templateItemId = crypto.randomUUID()
  const bomId = crypto.randomUUID()
  const bomComponentId = crypto.randomUUID()
  const bomRouteId = crypto.randomUUID()
  const bomByproductId = crypto.randomUUID()
  const moldMaterialId = crypto.randomUUID()
  const moldDesignId = crypto.randomUUID()
  const childMaterialId = crypto.randomUUID()
  const fullRoleId = crypto.randomUUID()
  const readRoleId = crypto.randomUUID()
  const moldOnlyRoleId = crypto.randomUUID()
  const unitCreateRoleId = crypto.randomUUID()

  let fullUserId = ''
  let readUserId = ''
  let moldOnlyUserId = ''
  let unitCreateUserId = ''
  let fullHeaders: Record<string, string> = {}
  let readHeaders: Record<string, string> = {}
  let moldOnlyHeaders: Record<string, string> = {}
  let unitCreateHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  async function grant(roleId: string, codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
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
    app.request(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { headers })
  const del = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { method: 'DELETE', headers })

  /** 列表路径的别名回归：断言**本人可达的行在结果里**（只断言别人的不在，对空集永真） */
  async function listIds(
    path: string,
    headers: Record<string, string>,
    body: Record<string, unknown> = {},
  ): Promise<string[]> {
    const res = await post(path, headers, { limit: 200, offset: 0, ...body })
    expect([path, res.status]).toEqual([path, 200])
    const parsed = (await res.json()) as { results: Array<{ id: string }> }
    return parsed.results.map((r) => r.id)
  }

  async function errorCode(res: Response): Promise<string> {
    const body = (await res.json()) as { error?: { code?: string } }
    return body.error?.code ?? ''
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'扫11币-' + suffix}, ${'W' + suffix.slice(0, 2).toUpperCase()}, 'W', true)
    `.execute(db)
    await db
      .insertInto('bas_unit')
      .values([
        {
          id: unitId,
          unit_type: 'quantity',
          is_base: false,
          name: `扫11单位-${suffix}`,
          symbol: `w${suffix.slice(0, 5)}`,
          ratio: '1',
        },
        {
          id: unitAltId,
          unit_type: 'quantity',
          is_base: false,
          name: `扫11箱-${suffix}`,
          symbol: `x${suffix.slice(0, 5)}`,
          ratio: '1',
        },
      ])
      .execute()
    for (const [id, code, name] of [
      [companyA, 'WA', '扫11公司甲'],
      [companyB, 'WB', '扫11公司乙'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${name + suffix}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    await db
      .insertInto('inv_material_category')
      .values([
        { id: categoryRoot, code: `WR${suffix}`, name: `扫11根类-${suffix}`, is_leaf: false },
        {
          id: categoryLeaf,
          code: `WL${suffix}`,
          name: `扫11叶类-${suffix}`,
          is_leaf: true,
          parent_id: categoryRoot,
        },
      ])
      .execute()
    await db
      .insertInto('inv_material')
      .values([
        {
          id: materialId,
          code: `WM${suffix}`,
          name: `扫11物料-${suffix}`,
          material_type: 'STOCK',
          category_id: categoryLeaf,
          default_unit_id: unitId,
        },
        {
          id: childMaterialId,
          code: `WC${suffix}`,
          name: `扫11子料-${suffix}`,
          material_type: 'STOCK',
          category_id: categoryLeaf,
          default_unit_id: unitId,
        },
        {
          id: moldMaterialId,
          code: `WD${suffix}`,
          name: `扫11模具料-${suffix}`,
          material_type: 'ASSET',
          category_id: categoryLeaf,
          default_unit_id: unitId,
        },
      ])
      .execute()
    await db
      .insertInto('inv_material_unit')
      .values({ id: materialUnitId, material_id: materialId, unit_id: unitAltId, factor: '10' })
      .execute()
    await db
      .insertInto('pur_supplier')
      .values({ id: supplierId, code: `WS${suffix}`, name: `扫11供应商-${suffix}` })
      .execute()
    await db
      .insertInto('inv_warehouse')
      .values([
        { id: warehouseRootA, code: `WR${suffix}`, name: `甲根仓-${suffix}`, is_leaf: false, company_id: companyA },
        {
          id: warehouseOutsourcedA,
          code: `WQ${suffix}`,
          name: `甲外协仓-${suffix}`,
          is_leaf: true,
          company_id: companyA,
          parent_id: warehouseRootA,
          is_outsourced: true,
          party_type: 'supplier',
          party_id: supplierId,
        },
        { id: warehouseB, code: `WW${suffix}`, name: `乙仓-${suffix}`, is_leaf: true, company_id: companyB },
      ])
      .execute()
    await db
      .insertInto('mfg_operation')
      .values({ id: operationId, code: `WO${suffix}`, name: `扫11工序-${suffix}` })
      .execute()
    await db
      .insertInto('mfg_process_template')
      .values({ id: templateId, code: `WT${suffix}`, name: `扫11模板-${suffix}` })
      .execute()
    await db
      .insertInto('mfg_process_template_item')
      .values({
        id: templateItemId,
        template_id: templateId,
        operation_id: operationId,
        seq: '10',
      })
      .execute()
    await db
      .insertInto('mfg_bom')
      .values({ id: bomId, code: `WB${suffix}`, material_id: materialId, status: 'active' })
      .execute()
    await db
      .insertInto('mfg_bom_component')
      .values({
        id: bomComponentId,
        bom_id: bomId,
        material_id: childMaterialId,
        unit_id: unitId,
        quantity: '2',
      })
      .execute()
    await db
      .insertInto('mfg_bom_route')
      .values({ id: bomRouteId, bom_id: bomId, operation_id: operationId, seq: '10' })
      .execute()
    await db
      .insertInto('mfg_bom_byproduct')
      .values({
        id: bomByproductId,
        bom_id: bomId,
        material_id: childMaterialId,
        unit_id: unitId,
        quantity: '1',
      })
      .execute()
    await db
      .insertInto('mfg_mold_design')
      .values({ id: moldDesignId, material_id: moldMaterialId, mold_type: 'STAMPING' })
      .execute()
    await db
      .insertInto('sys_role')
      .values([
        { id: fullRoleId, code: `sweep11-full-${suffix}`, name: `扫11全量-${suffix}` },
        { id: readRoleId, code: `sweep11-read-${suffix}`, name: `扫11只读-${suffix}` },
        { id: moldOnlyRoleId, code: `sweep11-mold-${suffix}`, name: `扫11模具-${suffix}` },
        { id: unitCreateRoleId, code: `sweep11-unit-${suffix}`, name: `扫11单位-${suffix}` },
      ])
      .execute()
    await grant(fullRoleId, FULL_CODES)
    await grant(readRoleId, READ_ONLY_CODES)
    // 只有模具 create、没有物料 create：验跨资源 allOf（建模具必然连带建物料）
    await grant(moldOnlyRoleId, ['mfg.mold_design:read', 'mfg.mold_design:create'])
    // 只有物料 create、没有物料 update：验单位转换写的 anyOf（create ∨ update）
    await grant(unitCreateRoleId, ['base.material:read', 'base.material:create'])

    app = await buildTestApp(db)
    // 四个用户都只授权公司甲：仓库（唯一公司域资源）的跨公司边界由此可验
    for (const [roleId, tag] of [
      [fullRoleId, 'full'],
      [readRoleId, 'read'],
      [moldOnlyRoleId, 'mold'],
      [unitCreateRoleId, 'unit'],
    ] as const) {
      const created = await iam.createUser(adminUserPermit(), {
        username: `sweep11-${tag}-${suffix}`,
        name: `扫11-${tag}`,
        roleIds: [roleId],
        companyIds: [companyA],
      })
      const headers = await login(`sweep11-${tag}-${suffix}`, created.password)
      if (tag === 'full') {
        fullUserId = created.user.id
        fullHeaders = headers
      } else if (tag === 'read') {
        readUserId = created.user.id
        readHeaders = headers
      } else if (tag === 'mold') {
        moldOnlyUserId = created.user.id
        moldOnlyHeaders = headers
      } else {
        unitCreateUserId = created.user.id
        unitCreateHeaders = headers
      }
    }
  })

  afterAll(async () => {
    for (const id of [fullUserId, readUserId, moldOnlyUserId, unitCreateUserId]) {
      if (!id) continue
      await db.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      const row = await db
        .selectFrom('sys_user')
        .select('auth_user_id')
        .where('id', '=', id)
        .executeTakeFirst()
      await db.deleteFrom('sys_user').where('id', '=', id).execute()
      if (row?.auth_user_id) {
        await db.deleteFrom('auth_user').where('id', '=', row.auth_user_id).execute()
      }
    }
    const roleIds = [fullRoleId, readRoleId, moldOnlyRoleId, unitCreateRoleId]
    await db.deleteFrom('sys_role_permission').where('role_id', 'in', roleIds).execute()
    await db.deleteFrom('sys_role').where('id', 'in', roleIds).execute()
    await db.deleteFrom('mfg_mold_design').where('id', '=', moldDesignId).execute()
    await db.deleteFrom('mfg_bom_byproduct').where('id', '=', bomByproductId).execute()
    await db.deleteFrom('mfg_bom_route').where('id', '=', bomRouteId).execute()
    await db.deleteFrom('mfg_bom_component').where('id', '=', bomComponentId).execute()
    await db.deleteFrom('mfg_bom').where('id', '=', bomId).execute()
    await db.deleteFrom('mfg_process_template_item').where('id', '=', templateItemId).execute()
    await db.deleteFrom('mfg_process_template').where('id', '=', templateId).execute()
    await db.deleteFrom('mfg_operation').where('id', '=', operationId).execute()
    await db
      .deleteFrom('inv_warehouse')
      .where('id', 'in', [warehouseOutsourcedA, warehouseRootA, warehouseB])
      .execute()
    await db.deleteFrom('pur_supplier').where('id', '=', supplierId).execute()
    await db.deleteFrom('inv_material_unit').where('id', '=', materialUnitId).execute()
    await db
      .deleteFrom('inv_material')
      .where('id', 'in', [materialId, childMaterialId, moldMaterialId])
      .execute()
    await db
      .deleteFrom('inv_material_category')
      .where('id', 'in', [categoryLeaf, categoryRoot])
      .execute()
    for (const id of [companyA, companyB]) {
      await db.deleteFrom('sys_audit_log').where('company_id', '=', id).execute()
      await db.deleteFrom('inv_warehouse').where('company_id', '=', id).execute()
      await db.deleteFrom('bas_company').where('id', '=', id).execute()
    }
    await db.deleteFrom('bas_unit').where('id', 'in', [unitId, unitAltId]).execute()
    await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    await db.destroy()
  })

  test('别名回归：13 条列表路径都能看到本人可达的行', async () => {
    // inventory 余量（子查询别名 material_category / material / material_unit / warehouse）
    expect(await listIds('/base/material-categories/query', fullHeaders)).toContain(categoryLeaf)
    expect(await listIds('/base/materials/query', fullHeaders)).toContain(materialId)
    expect(await listIds('/base/material-units/query', fullHeaders)).toContain(materialUnitId)
    expect(await listIds('/base/warehouses/query', fullHeaders)).toContain(warehouseRootA)
    expect(
      await listIds('/base/warehouses/outsourced/query', fullHeaders, {
        partyType: 'SUPPLIER',
        partyId: supplierId,
      }),
    ).toContain(warehouseOutsourcedA)
    // manufacturing 余量（裸表别名）
    expect(await listIds('/manufacturing/operations/query', fullHeaders)).toContain(operationId)
    expect(await listIds('/manufacturing/process-templates/query', fullHeaders)).toContain(templateId)
    expect(await listIds('/manufacturing/process-template-items/query', fullHeaders)).toContain(
      templateItemId,
    )
    expect(await listIds('/manufacturing/boms/query', fullHeaders)).toContain(bomId)
    expect(await listIds('/manufacturing/bom-components/query', fullHeaders)).toContain(bomComponentId)
    expect(await listIds('/manufacturing/bom-routes/query', fullHeaders)).toContain(bomRouteId)
    expect(await listIds('/manufacturing/bom-byproducts/query', fullHeaders)).toContain(bomByproductId)
    expect(await listIds('/manufacturing/mold-designs/query', fullHeaders)).toContain(moldDesignId)
  })

  test('公司域（仓库）：跨公司单条 404、列表不含；本公司同路径 200', async () => {
    const cross = await get(`/base/warehouses/${warehouseB}`, fullHeaders)
    expect(cross.status).toBe(404)
    expect(await errorCode(cross)).toBe('not_found')
    expect(await listIds('/base/warehouses/query', fullHeaders)).not.toContain(warehouseB)
    expect((await get(`/base/warehouses/${warehouseRootA}`, fullHeaders)).status).toBe(200)
    // 写路径同样收敛为 404（旧 forbidden「无权在该公司下操作数据」）
    const crossPatch = await app.request(`/api/v1/base/warehouses/${warehouseB}`, {
      method: 'PATCH',
      headers: fullHeaders,
      body: JSON.stringify({ name: `不该改-${suffix}` }),
    })
    expect(crossPatch.status).toBe(404)
    const crossDelete = await del(`/base/warehouses/${warehouseB}`, fullHeaders)
    expect(crossDelete.status).toBe(404)
  })

  test('create 到未授权公司：404 公司不存在（旧 forbidden）；companyId 为空先 400', async () => {
    const toB = await post('/base/warehouses', fullHeaders, {
      name: `乙司新仓-${suffix}`,
      companyId: companyB,
    })
    expect(toB.status).toBe(404)
    expect(await errorCode(toB)).toBe('not_found')
    // 入参校验（400）先于公司边界（404）
    const blank = await post('/base/warehouses', fullHeaders, { name: '', companyId: companyB })
    expect(blank.status).toBe(400)
    expect(await errorCode(blank)).toBe('validation')
    // seed-defaults 同口径
    const seedB = await post('/base/warehouses/seed-defaults', fullHeaders, { companyId: companyB })
    expect(seedB.status).toBe(404)
  })

  test('via 子行单条读：经 EXISTS 递归归宿（单位转换 / BOM 子行 / 模板行）', async () => {
    for (const path of [
      `/base/material-units/${materialUnitId}`,
      `/manufacturing/process-template-items/${templateItemId}`,
      `/manufacturing/bom-components/${bomComponentId}`,
      `/manufacturing/bom-routes/${bomRouteId}`,
      `/manufacturing/bom-byproducts/${bomByproductId}`,
    ]) {
      expect([path, (await get(path, fullHeaders)).status]).toEqual([path, 200])
    }
    // 归宿不存在的子行 id → not_found（不泄露存在性）
    const ghost = await get(`/manufacturing/bom-components/${crypto.randomUUID()}`, fullHeaders)
    expect(ghost.status).toBe(404)
  })

  test('缺码 403：403 的唯一成因是动作码不满足', async () => {
    const denied = await post('/base/warehouses', readHeaders, {
      name: `不该建-${suffix}`,
      companyId: companyA,
    })
    expect(denied.status).toBe(403)
    expect(await errorCode(denied)).toBe('forbidden')
    // 同角色的读码可用（对照：不是整条链都被拒）
    expect((await get(`/base/warehouses/${warehouseRootA}`, readHeaders)).status).toBe(200)
    // 分类删除码只读角色没有
    const catDenied = await del(`/base/material-categories/${categoryLeaf}`, readHeaders)
    expect(catDenied.status).toBe(403)
  })

  test('模具设计跨资源 allOf：缺 base.material:create 即 403，齐码非 403', async () => {
    const body = { name: `扫11新模-${suffix}`, moldType: 'OTHER', unitId }
    const onlyMold = await post('/manufacturing/mold-designs', moldOnlyHeaders, body)
    expect(onlyMold.status).toBe(403)
    expect(await errorCode(onlyMold)).toBe('forbidden')
    // 读码单独成立（证明 403 只出在 create 的 allOf 上）
    expect((await get(`/manufacturing/mold-designs/${moldDesignId}`, moldOnlyHeaders)).status).toBe(200)
    // 补上物料码后不再是 403（落到领域前置：模具分类未配 / 未配编号规则）
    await grant(moldOnlyRoleId, [
      'mfg.mold_design:read',
      'mfg.mold_design:create',
      'base.material:create',
    ])
    const both = await post('/manufacturing/mold-designs', moldOnlyHeaders, body)
    expect(both.status).not.toBe(403)
    expect(await errorCode(both)).not.toBe('forbidden')
    await grant(moldOnlyRoleId, ['mfg.mold_design:read', 'mfg.mold_design:create'])
  })

  test('单位转换写 anyOf：只有 base.material:create 也能建（旧 requireAnyPermission 语义）', async () => {
    const created = await post('/base/material-units', unitCreateHeaders, {
      materialId,
      unitId,
      factor: '3',
    })
    // 只有 create 码 → 通过 anyOf 的码级判定；落到领域校验（不能选默认单位自身）
    expect(created.status).not.toBe(403)
    expect(await errorCode(created)).not.toBe('forbidden')
    // 两码都没有的只读角色 → 403
    const denied = await post('/base/material-units', readHeaders, {
      materialId,
      unitId: unitAltId,
      factor: '3',
    })
    expect(denied.status).toBe(403)
  })

  test('状态守卫 409：领域不变量没有被卷进权限系统', async () => {
    // 分类有下级 → conflict（不是 forbidden、也不是 not_found）
    const res = await del(`/base/material-categories/${categoryRoot}`, fullHeaders)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('conflict')
    // 仓库有下级 → conflict
    const wh = await del(`/base/warehouses/${warehouseRootA}`, fullHeaders)
    expect(wh.status).toBe(409)
    expect(await errorCode(wh)).toBe('conflict')
  })

  test('global 资源：矩阵不开行级范围（supportedScopes 只有 all）', async () => {
    const res = await get('/meta/permission-catalog', fullHeaders)
    expect(res.status).toBe(200)
    const catalog = (await res.json()) as {
      groups: { prefix: string; supportedScopes: string[] }[]
    }
    // 物料/分类是 global；单位转换 via 物料（同前缀不新增档位）
    // 工序/工艺模板/BOM/模具设计同为 global
    for (const prefix of [
      'base.material_category',
      'base.material',
      'mfg.operation',
      'mfg.route_template',
      'mfg.bom',
      'mfg.mold_design',
    ]) {
      const group = catalog.groups.find((g) => g.prefix === prefix)
      expect(group, `权限目录缺少前缀 ${prefix}`).toBeTruthy()
      expect(group!.supportedScopes, `${prefix} 不应开放行级范围`).toEqual(['all'])
    }
    // 公司域的仓库同样无 owner/dept 声明，也只应授出 all
    expect(catalog.groups.find((g) => g.prefix === 'base.warehouse')?.supportedScopes).toEqual(['all'])
  })

  test('零公司授权：global 主数据照读，公司域仓库清空（spec §5）', async () => {
    // Actor 缓存 ttlMs: 0 → 改授权后同一 token 即刻生效
    await db.deleteFrom('sys_user_company').where('user_id', '=', readUserId).execute()
    expect(await listIds('/base/materials/query', readHeaders)).toContain(materialId)
    expect(await listIds('/base/material-categories/query', readHeaders)).toContain(categoryLeaf)
    expect(await listIds('/manufacturing/boms/query', readHeaders)).toContain(bomId)
    // 公司域：行过滤编译为 false（空列表，`empty` 早退义务已消失）；单条 404
    expect(await listIds('/base/warehouses/query', readHeaders)).toHaveLength(0)
    expect((await get(`/base/warehouses/${warehouseRootA}`, readHeaders)).status).toBe(404)
    await db
      .insertInto('sys_user_company')
      .values({ user_id: readUserId, company_id: companyA })
      .execute()
  })
})
