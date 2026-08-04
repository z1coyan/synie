/**
 * 销售/采购订单 Aggregate Draft PG 集成：完整 HTTP seam、采购委外子树与回滚。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import type { TradingSide } from '../common.ts'
import { createQuotationService } from '../quotation/service.ts'
import { createOutsourcedConfigService } from './outsourced-config.ts'
import { orderHeadRoutes } from './routes.ts'
import {
  createOrderService,
  type OrderDraftInput,
  type OrderSavedDraft,
} from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（销售/采购订单 Aggregate Draft）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry()))
  const quotations = createQuotationService(db, numbering)
  const outsourcedConfig = createOutsourcedConfigService(db)
  const orders = createOrderService(
    db,
    numbering,
    quotations,
    outsourcedConfig.draft,
  )
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `OD${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()
  const rawMaterialId = crypto.randomUUID()
  const byproductId = crypto.randomUUID()

  const actor: Actor = {
    userId: '',
    username: 'order-draft-test',
    name: '订单聚合草稿测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  const auth = {
    authenticate: async () => actor,
    authenticateRequest: async () => actor,
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route(
      '/api/v1/sales/orders',
      orderHeadRoutes({ auth, orders, side: 'sales' }),
    )
    .route(
      '/api/v1/purchase/orders',
      orderHeadRoutes({ auth, orders, side: 'purchase' }),
    )
  http.onError(onError)

  function draftInput(
    side: TradingSide,
    orderNo: string,
  ): OrderDraftInput {
    return {
      companyId,
      orderNo,
      orderDate: '2026-07-31',
      orderType: side === 'sales' ? 'SAMPLE' : 'SPOT',
      isOutsourced: side === 'purchase',
      partyType: side === 'sales' ? 'CUSTOMER' : 'SUPPLIER',
      partyId: side === 'sales' ? customerId : supplierId,
      currencyId,
      exchangeRate: '1',
      terms: '初始条款',
      remarks: null,
      items: [{
        idx: 1,
        qty: '10',
        materialId,
        unitId,
        price: '10',
        taxRate: '0.13',
        remarks: null,
        quotationItemId: null,
        bomId: null,
        demandLineId: null,
        demandDate: null,
        issueLines:
          side === 'purchase'
            ? [
                {
                  materialId: rawMaterialId,
                  unitId,
                  quantity: '20',
                  remarks: '主料',
                },
                {
                  materialId: material2Id,
                  unitId,
                  quantity: '2',
                  remarks: '辅料',
                },
              ]
            : [],
        byproductLines:
          side === 'purchase'
            ? [
                {
                  materialId: byproductId,
                  unitId,
                  quantity: '1',
                  remarks: '副产物',
                },
                {
                  materialId: material2Id,
                  unitId,
                  quantity: '0.5',
                  remarks: '副产物二',
                },
              ]
            : [],
      }],
    }
  }

  function limitedActor(...actions: Array<'update' | 'create' | 'delete'>): Actor {
    return {
      ...actor,
      username: `order-${actions.join('-')}`,
      superAdmin: false,
      permissions: new Set(actions.map((action) => `purchase.order:${action}`)),
    }
  }

  function replaceInputFromSaved(saved: OrderSavedDraft): OrderDraftInput {
    return {
      companyId: saved.companyId,
      orderNo: saved.orderNo,
      orderDate: saved.orderDate,
      orderType: saved.orderType,
      isOutsourced: saved.isOutsourced,
      partyType: saved.partyType,
      partyId: saved.partyId,
      currencyId: saved.currencyId,
      exchangeRate: saved.exchangeRate,
      terms: saved.terms,
      remarks: saved.remarks,
      items: saved.items.map((item) => ({
        id: item.id,
        idx: item.idx,
        qty: item.qty,
        materialId: item.materialId,
        unitId: item.unitId,
        price: item.price,
        taxRate: item.taxRate,
        remarks: item.remarks,
        quotationItemId: item.quotationItemId,
        bomId: item.bomId ?? null,
        demandLineId: item.demandLineId ?? null,
        demandDate: item.demandDate ?? null,
        issueLines: item.issueLines.map((line) => ({
          id: line.id,
          materialId: line.materialId,
          unitId: line.unitId,
          quantity: line.quantity,
          remarks: line.remarks,
        })),
        byproductLines: item.byproductLines.map((line) => ({
          id: line.id,
          materialId: line.materialId,
          unitId: line.unitId,
          quantity: line.quantity,
          remarks: line.remarks,
        })),
      })),
    }
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'O' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'OD', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '供应商'}, 'SU')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'od-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active) VALUES
        (${materialId}::uuid, ${'M' + suffix}, ${prefix + '物料'}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${material2Id}::uuid, ${'N' + suffix}, ${prefix + '物料二'}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${rawMaterialId}::uuid, ${'R' + suffix}, ${prefix + '原料'}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${byproductId}::uuid, ${'B' + suffix}, ${prefix + '副产物'}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
  })

  afterAll(async () => {
    await sql`
      DELETE FROM sys_attachment
      WHERE owner_type IN ('sal_order_item','pur_order_item')
        AND owner_id IN (
          SELECT id FROM sal_order_item WHERE company_id=${companyId}::uuid
          UNION ALL
          SELECT id FROM pur_order_item WHERE company_id=${companyId}::uuid
        )
    `.execute(db)
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_order WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`
      DELETE FROM inv_material WHERE id IN (
        ${materialId}::uuid,${material2Id}::uuid,
        ${rawMaterialId}::uuid,${byproductId}::uuid
      )
    `.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('销售/采购均经 Hono seam 整单创建、读取与替换', async () => {
    const headers = {
      authorization: 'Bearer test',
      'content-type': 'application/json',
    }
    for (const side of ['sales', 'purchase'] as const) {
      const input = draftInput(side, `${prefix}-${side}-HTTP`)
      const createdResponse = await http.request(
        `/api/v1/${side}/orders`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        },
      )
      expect(createdResponse.status).toBe(201)
      const created = await createdResponse.json() as OrderSavedDraft
      expect(created.items).toHaveLength(1)
      expect(created.items[0]?.issueLines).toHaveLength(
        side === 'purchase' ? 2 : 0,
      )
      expect(created.items[0]?.byproductLines).toHaveLength(
        side === 'purchase' ? 2 : 0,
      )

      const loadedResponse = await http.request(
        `/api/v1/${side}/orders/${created.id}/draft`,
        { headers: { authorization: 'Bearer test' } },
      )
      expect(loadedResponse.status).toBe(200)
      expect(await loadedResponse.json()).toEqual(created)

      const item = created.items[0]!
      const keptIssue = item.issueLines[0]
      const removedIssue = item.issueLines[1]
      const keptByproduct = item.byproductLines[0]
      const removedByproduct = item.byproductLines[1]
      const replacedResponse = await http.request(
        `/api/v1/${side}/orders/${created.id}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            ...input,
            terms: '整单替换',
            items: [{
              ...input.items[0],
              id: item.id,
              qty: '12',
              issueLines:
                side === 'purchase'
                  ? [
                      {
                        id: keptIssue!.id,
                        materialId: rawMaterialId,
                        unitId,
                        quantity: '24',
                        remarks: '保留并更新',
                      },
                      {
                        materialId,
                        unitId,
                        quantity: '3',
                        remarks: '新增',
                      },
                    ]
                  : [],
              byproductLines:
                side === 'purchase'
                  ? [{
                      id: keptByproduct!.id,
                      materialId: byproductId,
                      unitId,
                      quantity: '2',
                      remarks: '保留并更新',
                    }]
                  : [],
            }],
          }),
        },
      )
      expect(replacedResponse.status).toBe(200)
      const replaced = await replacedResponse.json() as OrderSavedDraft
      expect(replaced.terms).toBe('整单替换')
      expect(replaced.items[0]?.id).toBe(item.id)
      expect(replaced.items[0]?.qty).toBe('12')
      if (side === 'purchase') {
        expect(replaced.items[0]?.issueLines).toHaveLength(2)
        expect(replaced.items[0]?.issueLines[0]?.id).toBe(keptIssue?.id)
        expect(replaced.items[0]?.byproductLines).toHaveLength(1)
        expect(replaced.items[0]?.byproductLines[0]?.id).toBe(
          keptByproduct?.id,
        )
        const deleted = await sql<{ issue: boolean; byproduct: boolean }>`
          SELECT
            EXISTS(
              SELECT 1 FROM pur_order_item_material
              WHERE id=${removedIssue!.id}::uuid
            ) AS issue,
            EXISTS(
              SELECT 1 FROM pur_order_item_byproduct
              WHERE id=${removedByproduct!.id}::uuid
            ) AS byproduct
        `.execute(db)
        expect(deleted.rows[0]).toEqual({
          issue: false,
          byproduct: false,
        })
      }
    }
  })

  test('第二个嵌套条目失败时销售/采购创建均不残留表头或子记录', async () => {
    for (const side of ['sales', 'purchase'] as const) {
      const no = `${prefix}-CR-${side[0]}`
      const input = draftInput(side, no)
      input.items.push({
        ...input.items[0]!,
        idx: 2,
        materialId: material2Id,
        qty: '0',
        issueLines: [],
        byproductLines: [],
      })
      await expect(
        orders.createDraft(actor, side, input),
      ).rejects.toThrow(/订单条目参数不合法/)

      const count = side === 'sales'
        ? await sql<{ heads: string; items: string }>`
            SELECT
              (SELECT count(*) FROM sal_order WHERE order_no=${no})::text AS heads,
              (
                SELECT count(*) FROM sal_order_item i
                JOIN sal_order o ON o.id=i.order_id WHERE o.order_no=${no}
              )::text AS items
          `.execute(db)
        : await sql<{ heads: string; items: string }>`
            SELECT
              (SELECT count(*) FROM pur_order WHERE order_no=${no})::text AS heads,
              (
                SELECT count(*) FROM pur_order_item i
                JOIN pur_order o ON o.id=i.order_id WHERE o.order_no=${no}
              )::text AS items
          `.execute(db)
      expect(count.rows[0]).toEqual({ heads: '0', items: '0' })
    }
  })

  test('第二个副产物失败时头、条目、发料与副产物修改全部回滚', async () => {
    const created = await orders.createDraft(
      actor,
      'purchase',
      draftInput('purchase', `${prefix}-P-RB`),
    )
    const before = await orders.getDraft(actor, 'purchase', created.id)
    const item = created.items[0]!
    const issue = item.issueLines[0]!
    const byproduct = item.byproductLines[0]!

    await expect(
      orders.replaceDraft(actor, 'purchase', created.id, {
        ...draftInput('purchase', created.orderNo),
        terms: '失败后不可见',
        items: [{
          ...draftInput('purchase', created.orderNo).items[0]!,
          id: item.id,
          qty: '99',
          issueLines: [{
            id: issue.id,
            materialId: rawMaterialId,
            unitId,
            quantity: '88',
            remarks: '应回滚',
          }],
          byproductLines: [
            {
              id: byproduct.id,
              materialId: byproductId,
              unitId,
              quantity: '2',
              remarks: '应回滚',
            },
            {
              materialId: material2Id,
              unitId,
              quantity: '0',
              remarks: '触发失败',
            },
          ],
        }],
      }),
    ).rejects.toThrow(/副产物清单参数不合法/)

    expect(await orders.getDraft(actor, 'purchase', created.id)).toEqual(before)
  })

  test('订单 replace 仅在新增/删除子树时追加 create/delete 权限', async () => {
    const created = await orders.createDraft(
      actor,
      'purchase',
      draftInput('purchase', `${prefix}-PUR-RBAC`),
    )
    const updateOnly = limitedActor('update')

    const pureUpdate = replaceInputFromSaved(created)
    pureUpdate.terms = '仅修改已有快照'
    const purelyUpdated = await orders.replaceDraft(
      updateOnly,
      'purchase',
      created.id,
      pureUpdate,
    )
    expect(purelyUpdated.terms).toBe('仅修改已有快照')

    const withNewOutsourcedLine = replaceInputFromSaved(purelyUpdated)
    withNewOutsourcedLine.items[0]!.issueLines.push({
      materialId,
      unitId,
      quantity: '3',
      remarks: '新增委外行',
    })
    await expect(
      orders.replaceDraft(updateOnly, 'purchase', created.id, withNewOutsourcedLine),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const withCreate = await orders.replaceDraft(
      limitedActor('update', 'create'),
      'purchase',
      created.id,
      withNewOutsourcedLine,
    )
    expect(withCreate.items[0]?.issueLines).toHaveLength(3)

    const withoutAddedLine = replaceInputFromSaved(withCreate)
    withoutAddedLine.items[0]!.issueLines = withoutAddedLine.items[0]!.issueLines.slice(0, 2)
    await expect(
      orders.replaceDraft(updateOnly, 'purchase', created.id, withoutAddedLine),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const withDelete = await orders.replaceDraft(
      limitedActor('update', 'delete'),
      'purchase',
      created.id,
      withoutAddedLine,
    )
    expect(withDelete.items[0]?.issueLines).toHaveLength(2)
  })
})
