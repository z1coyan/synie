/**
 * 订单收发货历史（只读投影）PG 集成：readAnyOf「声明即执行」+ 公司行过滤。
 *
 * 该资源无独立权限点：read 的码级组合子由 meta 的 authz.readAnyOf 声明（四种来源单据 read 的 OR），
 * 由 guard 编译成 anyOf——任一码命中即 200，四码全缺由 HTTP guard 层 403。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { testActor } from '~/platform/authz/testing.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { ORDER_FLOW_SOURCE_READ_PERMISSIONS } from './meta.ts'
import { orderFlowRoutes } from './routes.ts'
import { createOrderFlowService, FLOW_RESOURCE } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（订单收发货历史投影）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  const orderFlow = createOrderFlowService(db, registry)

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const warehouseId = crypto.randomUUID()
  const otherWarehouseId = crypto.randomUUID()
  const debitId = crypto.randomUUID()
  const creditId = crypto.randomUUID()
  const orderId = crypto.randomUUID()
  const orderItemId = crypto.randomUUID()
  const deliveryId = crypto.randomUUID()
  const deliveryItemId = crypto.randomUUID()
  const otherOrderId = crypto.randomUUID()
  const otherOrderItemId = crypto.randomUUID()
  const otherDeliveryId = crypto.randomUUID()
  const otherDeliveryItemId = crypto.randomUUID()

  /** 视图主键是「单据类型:uuid」文本 */
  const flowId = `sales_delivery:${deliveryItemId}`
  const otherFlowId = `sales_delivery:${otherDeliveryItemId}`

  function scopedActor(companyIds: string[], permissions: string[]): Actor {
    return testActor({
      username: `flow-${permissions.length}`,
      superAdmin: false,
      allCompanies: false,
      permissions: new Set(permissions),
      companyIds,
    })
  }

  /** 凭证每次现取（actor 在用例间改写） */
  function permitFor(who: Actor): Permit {
    const decision = authz.decideFor(who, FLOW_RESOURCE, 'read')
    if (decision.outcome !== 'permit') throw new Error('应当 permit：订单收发货历史 read')
    return decision.permit
  }

  let httpActor: Actor = scopedActor([companyId], ['sales.delivery:read'])
  const auth = {
    authenticate: async () => httpActor,
    authenticateRequest: async () => httpActor,
  } as unknown as AuthService
  const http = new Hono<AppEnv>().route(
    '/api/v1/base/order-flow-items',
    orderFlowRoutes({ auth, authz, orderFlow }),
  )
  http.onError(onError)
  const call = (path: string, init?: RequestInit) =>
    http.request(`/api/v1/base/order-flow-items${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
  const query = (body: Record<string, unknown> = { limit: 50, offset: 0 }) =>
    call('/query', { method: 'POST', body: JSON.stringify(body) })

  async function seedChain(args: {
    company: string
    warehouse: string
    order: string
    orderItem: string
    delivery: string
    deliveryItem: string
    tag: string
  }) {
    await sql`
      INSERT INTO sal_order(id,order_no,order_date,party_type,party_id,status,company_id,currency_id)
      VALUES (
        ${args.order}::uuid, ${`SO${args.tag}${suffix}`}, CURRENT_DATE, 'customer',
        ${customerId}::uuid, 'audited', ${args.company}::uuid, ${currencyId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_order_item(
        id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty
      ) VALUES (
        ${args.orderItem}::uuid,1,10,10,100,${args.order}::uuid,${args.company}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${`M${suffix}`},${`料${suffix}`},${`件${suffix}`},10
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery(
        id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id
      ) VALUES (
        ${args.delivery}::uuid,${`SD${args.tag}${suffix}`},CURRENT_DATE,'customer',
        ${customerId}::uuid,'audited',${args.company}::uuid,${args.warehouse}::uuid,
        ${debitId}::uuid,${creditId}::uuid
      )
    `.execute(db)
    await sql`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id
      ) VALUES (
        ${args.deliveryItem}::uuid,1,10,10,${`M${suffix}`},${`料${suffix}`},${`件${suffix}`},
        ${`SO${args.tag}${suffix}`},10,10,${`件${suffix}`},10,100,10,100,0,${`F${suffix.slice(0, 2)}`},
        ${args.delivery}::uuid,${args.company}::uuid,${args.orderItem}::uuid,
        ${materialId}::uuid,${unitId}::uuid,${args.warehouse}::uuid
      )
    `.execute(db)
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${`流水币${suffix}`}, ${`F${suffix.slice(0, 2)}`}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${companyId}::uuid, ${`FA${suffix}`}, ${`流水公司A${suffix}`}, 'FA', ${currencyId}::uuid),
        (${otherCompanyId}::uuid, ${`FB${suffix}`}, ${`流水公司B${suffix}`}, 'FB', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${`FC${suffix}`}, ${`流水客户${suffix}`}, 'FC')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (
        ${unitId}::uuid, ${`flow-${suffix}`}, true, ${`件${suffix}`},
        ${`u${suffix.slice(0, 6)}`}, 1
      )
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${`FMC${suffix}`}, ${`流水类${suffix}`}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,default_unit_id,category_id,active)
      VALUES (
        ${materialId}::uuid, ${`M${suffix}`}, ${`料${suffix}`},
        ${unitId}::uuid, ${categoryId}::uuid, true
      )
    `.execute(db)
    await sql`
      INSERT INTO inv_warehouse(id,name,company_id) VALUES
        (${warehouseId}::uuid, ${`仓A${suffix}`}, ${companyId}::uuid),
        (${otherWarehouseId}::uuid, ${`仓B${suffix}`}, ${otherCompanyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id) VALUES
        (${debitId}::uuid, ${`FD${suffix}`}, ${`流水借${suffix}`}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid),
        (${creditId}::uuid, ${`FR${suffix}`}, ${`流水贷${suffix}`}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid)
    `.execute(db)

    await seedChain({
      company: companyId,
      warehouse: warehouseId,
      order: orderId,
      orderItem: orderItemId,
      delivery: deliveryId,
      deliveryItem: deliveryItemId,
      tag: 'A',
    })
    await seedChain({
      company: otherCompanyId,
      warehouse: otherWarehouseId,
      order: otherOrderId,
      orderItem: otherOrderItemId,
      delivery: otherDeliveryId,
      deliveryItem: otherDeliveryItemId,
      tag: 'B',
    })
  })

  afterAll(async () => {
    // 单据先删（两司共用 A 司科目，账户必须在全部单据之后删）
    for (const id of [companyId, otherCompanyId]) {
      await sql`DELETE FROM sal_delivery_item WHERE company_id=${id}::uuid`.execute(db)
      await sql`DELETE FROM sal_delivery WHERE company_id=${id}::uuid`.execute(db)
      await sql`DELETE FROM sal_order_item WHERE company_id=${id}::uuid`.execute(db)
      await sql`DELETE FROM sal_order WHERE company_id=${id}::uuid`.execute(db)
    }
    for (const id of [companyId, otherCompanyId]) {
      await sql`DELETE FROM inv_warehouse WHERE company_id=${id}::uuid`.execute(db)
      await sql`DELETE FROM bas_account WHERE company_id=${id}::uuid`.execute(db)
    }
    await sql`DELETE FROM inv_material WHERE id=${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id IN (${companyId}::uuid, ${otherCompanyId}::uuid)`.execute(
      db,
    )
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('声明即执行：read 的码级组合子取自请求资源的 readAnyOf（无自有 read 码）', () => {
    const target = authz.targetOf(FLOW_RESOURCE)
    // 非 via：判定归宿即自身，readAnyOf 取请求资源声明（无声明才回落宿主）
    expect(target.rootResource).toBe(FLOW_RESOURCE)
    expect([...target.readAnyOf]).toEqual([...ORDER_FLOW_SOURCE_READ_PERMISSIONS])
    // actions 为空但 read 仍被视为已声明：码由 readAnyOf 给出
    expect(registry.get(FLOW_RESOURCE)!.actions).toEqual([])
    expect(authz.hasAction(FLOW_RESOURCE, 'read')).toBe(true)
  })

  test('anyOf：仅 sales.delivery:read 即可读（别名回归：本公司行在结果里）', async () => {
    httpActor = scopedActor([companyId], ['sales.delivery:read'])
    const res = await query()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; results: { id: string }[] }
    const ids = body.results.map((r) => r.id)
    expect(ids).toContain(flowId)
    expect(ids).not.toContain(otherFlowId)

    const one = await call(`/${encodeURIComponent(flowId)}`)
    expect(one.status).toBe(200)
    expect(await one.json()).toMatchObject({
      id: flowId,
      flowType: 'SALES_DELIVERY',
      companyId,
      orderId,
      orderItemId,
    })
  })

  test('anyOf：换成 purchase.receipt:read 同样通过（四码 OR 由声明驱动）', async () => {
    httpActor = scopedActor([companyId], ['purchase.receipt:read'])
    const res = await query()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { id: string }[] }
    expect(body.results.map((r) => r.id)).toContain(flowId)

    // 另外两码同样成立（逐码证明声明的四元 OR 全部生效）
    for (const code of ['purchase.outsourced_issue:read', 'purchase.outsourced_receipt:read']) {
      httpActor = scopedActor([companyId], [code])
      expect((await query()).status).toBe(200)
    }
  })

  test('四码全缺：HTTP guard 层 403（403 只由码级判定产生）', async () => {
    httpActor = scopedActor([companyId], ['base.currency:read'])
    const listRes = await query()
    expect(listRes.status).toBe(403)
    expect(await listRes.json()).toMatchObject({ error: { code: 'forbidden' } })
    const oneRes = await call(`/${encodeURIComponent(flowId)}`)
    expect(oneRes.status).toBe(403)
  })

  test('跨公司单条 404；锚点筛选与 id 格式校验留在服务层', async () => {
    const scoped = scopedActor([companyId], ['sales.delivery:read'])
    httpActor = scoped

    // 跨公司：存在但不可达 → not_found
    const foreign = await call(`/${encodeURIComponent(otherFlowId)}`)
    expect(foreign.status).toBe(404)

    // 锚点筛选（领域条件 ∧ 授权谓词）
    const anchored = await orderFlow.list(permitFor(scoped), {
      limit: 50,
      offset: 0,
      filter: { orderId: { kind: 'fk', op: 'in', values: [orderId] } } as never,
    })
    expect(anchored.results.map((r) => r.id)).toEqual([flowId])
    const otherAnchored = await orderFlow.list(permitFor(scoped), {
      limit: 50,
      offset: 0,
      filter: { orderId: { kind: 'fk', op: 'in', values: [otherOrderId] } } as never,
    })
    expect(otherAnchored.count).toBe(0)

    // id 格式非法：400（ApiError.validation），不是 404
    const badId = await call(`/${encodeURIComponent('sales_delivery:not-a-uuid')}`)
    expect(badId.status).toBe(400)
    await expect(orderFlow.get(permitFor(scoped), 'nope')).rejects.toMatchObject({
      code: 'validation',
    })
  })

  test('零公司授权：码满足但行集为空（不早退、不泄露）', async () => {
    const noCompany = scopedActor([], ['sales.delivery:read'])
    const listed = await orderFlow.list(permitFor(noCompany), { limit: 50, offset: 0 })
    expect(listed.count).toBe(0)
    await expect(orderFlow.get(permitFor(noCompany), flowId)).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
