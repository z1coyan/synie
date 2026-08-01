/**
 * 销售/采购报价 Aggregate Draft PG 集成：完整 HTTP seam 与嵌套写入原子性。
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
import { createNumberingService } from '~/platform/numbering/index.ts'
import type { TradingSide } from '../common.ts'
import { quotationHeadRoutes } from './routes.ts'
import {
  createQuotationService,
  type QuotationDraftInput,
  type QuotationSavedDraft,
} from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（销售/采购报价 Aggregate Draft）', () => {
  const db = createDb(url!)
  const quotations = createQuotationService(db, createNumberingService(db))
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `QD${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const supplier2Id = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()

  const actor: Actor = {
    userId: '',
    username: 'quotation-draft-test',
    name: '报价聚合草稿测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }
  const auth = {
    authenticate: async () => actor,
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route(
      '/api/v1/sales/quotations',
      quotationHeadRoutes({ auth, quotations, side: 'sales' }),
    )
    .route(
      '/api/v1/purchase/quotations',
      quotationHeadRoutes({ auth, quotations, side: 'purchase' }),
    )
  http.onError(onError)

  function draftInput(
    side: TradingSide,
    quotationNo: string,
  ): QuotationDraftInput {
    return {
      companyId,
      quotationNo,
      quotationDate: '2026-07-31',
      validUntil: '2026-08-31',
      partyType: side === 'sales' ? 'CUSTOMER' : 'SUPPLIER',
      partyId: side === 'sales' ? customerId : supplierId,
      currencyId,
      terms: '初始条款',
      remarks: null,
      items: [
        {
          idx: 1,
          materialId,
          unitId,
          pricingMode: 'FIXED',
          price: '10',
          taxRate: '0.13',
          remarks: null,
          tiers: [],
        },
        {
          idx: 2,
          materialId: material2Id,
          unitId,
          pricingMode: 'QTY_TIERED',
          price: null,
          taxRate: '0.13',
          remarks: null,
          tiers: [
            { minQty: '10', price: '8' },
            { minQty: '100', price: '7' },
          ],
        },
      ],
    }
  }

  function limitedActor(...actions: Array<'update' | 'create' | 'delete'>): Actor {
    return {
      ...actor,
      username: `quotation-${actions.join('-')}`,
      superAdmin: false,
      permissions: new Set(actions.map((action) => `purchase.quotation:${action}`)),
    }
  }

  function replaceInputFromSaved(saved: QuotationSavedDraft): QuotationDraftInput {
    return {
      companyId: saved.companyId,
      quotationNo: saved.quotationNo,
      quotationDate: saved.quotationDate,
      validUntil: saved.validUntil,
      partyType: saved.partyType,
      partyId: saved.partyId,
      currencyId: saved.currencyId,
      terms: saved.terms,
      remarks: saved.remarks,
      items: saved.items.map((item) => ({
        id: item.id,
        idx: item.idx,
        materialId: item.materialId,
        unitId: item.unitId,
        pricingMode: item.pricingMode,
        price: item.price,
        taxRate: item.taxRate,
        remarks: item.remarks,
        tiers: item.tiers.map((tier) => ({
          id: tier.id,
          minQty: tier.minQty,
          price: tier.price,
        })),
      })),
    }
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'Q' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'QD', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO pur_supplier(id,code,name,short_name) VALUES
        (${supplierId}::uuid, ${'SU' + suffix}, ${prefix + '供应商'}, 'SU'),
        (${supplier2Id}::uuid, ${'SV' + suffix}, ${prefix + '供应商二'}, 'SV')
    `.execute(db)
    await sql`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES (${unitId}::uuid, ${'qd-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active) VALUES
        (${materialId}::uuid, ${'M' + suffix}, ${prefix + '物料'}, ${categoryId}::uuid, ${unitId}::uuid, true),
        (${material2Id}::uuid, ${'N' + suffix}, ${prefix + '物料二'}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_quotation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_quotation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`
      DELETE FROM inv_material WHERE id IN (${materialId}::uuid, ${material2Id}::uuid)
    `.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id IN (${supplierId}::uuid,${supplier2Id}::uuid)`.execute(db)
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
      const pathSide = side
      const input = draftInput(side, `${prefix}-${side}-HTTP`)
      const createdResponse = await http.request(
        `/api/v1/${pathSide}/quotations`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        },
      )
      expect(createdResponse.status).toBe(201)
      const created = await createdResponse.json() as QuotationSavedDraft
      expect(created.items).toHaveLength(2)
      expect(created.items[1]?.tiers).toHaveLength(2)

      const loadedResponse = await http.request(
        `/api/v1/${pathSide}/quotations/${created.id}/draft`,
        { headers: { authorization: 'Bearer test' } },
      )
      expect(loadedResponse.status).toBe(200)
      expect(await loadedResponse.json()).toEqual(created)

      const keptItem = created.items[1]!
      const keptTier = keptItem.tiers[0]!
      const replacedResponse = await http.request(
        `/api/v1/${pathSide}/quotations/${created.id}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            ...input,
            terms: '整单替换',
            items: [
              {
                id: keptItem.id,
                idx: 1,
                materialId: material2Id,
                unitId,
                pricingMode: 'QTY_TIERED',
                price: null,
                taxRate: '0.13',
                remarks: '保留行',
                tiers: [
                  { id: keptTier.id, minQty: '20', price: '6' },
                  { minQty: '200', price: '5' },
                ],
              },
              {
                idx: 2,
                materialId,
                unitId,
                pricingMode: 'FIXED',
                price: '9',
                taxRate: '0.13',
                remarks: null,
                tiers: [],
              },
            ],
          }),
        },
      )
      expect(replacedResponse.status).toBe(200)
      const replaced = await replacedResponse.json() as QuotationSavedDraft
      expect(replaced.terms).toBe('整单替换')
      expect(replaced.items).toHaveLength(2)
      expect(replaced.items[0]?.id).toBe(keptItem.id)
      expect(replaced.items[0]?.tiers[0]?.id).toBe(keptTier.id)
      expect(replaced.items[0]?.tiers[0]?.minQty).toBe('20')
      expect(replaced.items.some((item) => item.id === created.items[0]?.id)).toBe(false)
    }
  })

  test('任一嵌套价格档创建失败时销售/采购均不残留表头或条目', async () => {
    for (const side of ['sales', 'purchase'] as const) {
      const no = `${prefix}-CR-${side[0]}`
      const input = draftInput(side, no)
      input.items[1]!.tiers.push({ minQty: '0', price: '1' })

      await expect(
        quotations.createDraft(actor, side, input),
      ).rejects.toThrow(/报价价格档参数不合法/)

      const headCount = side === 'sales'
        ? await sql<{ count: string }>`
            SELECT count(*)::text AS count FROM sal_quotation WHERE quotation_no=${no}
          `.execute(db)
        : await sql<{ count: string }>`
            SELECT count(*)::text AS count FROM pur_quotation WHERE quotation_no=${no}
          `.execute(db)
      const itemCount = side === 'sales'
        ? await sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM sal_quotation_item i
            JOIN sal_quotation q ON q.id=i.quotation_id
            WHERE q.quotation_no=${no}
          `.execute(db)
        : await sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM pur_quotation_item i
            JOIN pur_quotation q ON q.id=i.quotation_id
            WHERE q.quotation_no=${no}
          `.execute(db)
      expect(headCount.rows[0]?.count).toBe('0')
      expect(itemCount.rows[0]?.count).toBe('0')
    }
  })

  test('嵌套替换失败时销售/采购均保持替换前完整快照', async () => {
    for (const side of ['sales', 'purchase'] as const) {
      const created = await quotations.createDraft(
        actor,
        side,
        draftInput(side, `${prefix}-RR-${side[0]}`),
      )
      const before = await quotations.getDraft(actor, side, created.id)
      const fixedItem = created.items[0]!
      const tieredItem = created.items[1]!
      const keptTier = tieredItem.tiers[0]!

      await expect(
        quotations.replaceDraft(actor, side, created.id, {
          ...draftInput(side, created.quotationNo),
          terms: '失败后不可见',
          items: [
            {
              id: fixedItem.id,
              idx: 1,
              materialId,
              unitId,
              pricingMode: 'FIXED',
              price: '999',
              taxRate: '0.13',
              remarks: null,
              tiers: [],
            },
            {
              id: tieredItem.id,
              idx: 2,
              materialId: material2Id,
              unitId,
              pricingMode: 'QTY_TIERED',
              price: null,
              taxRate: '0.13',
              remarks: null,
              tiers: [
                { id: keptTier.id, minQty: '20', price: '6' },
                { minQty: '0', price: '1' },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/报价价格档参数不合法/)

      expect(await quotations.getDraft(actor, side, created.id)).toEqual(before)
    }
  })

  test('报价全量替换可清空旧条目同时换对手，后续失败会恢复删除', async () => {
    const changed = await quotations.createDraft(
      actor,
      'purchase',
      draftInput('purchase', `${prefix}-PUR-PARTY-CHANGE`),
    )
    const changedResult = await quotations.replaceDraft(actor, 'purchase', changed.id, {
      ...replaceInputFromSaved(changed),
      partyId: supplier2Id,
      items: [],
    })
    expect(changedResult.partyId).toBe(supplier2Id)
    expect(changedResult.items).toEqual([])

    const rollback = await quotations.createDraft(
      actor,
      'purchase',
      draftInput('purchase', `${prefix}-PUR-PARTY-ROLLBACK`),
    )
    const before = await quotations.getDraft(actor, 'purchase', rollback.id)
    await expect(
      quotations.replaceDraft(actor, 'purchase', rollback.id, {
        ...replaceInputFromSaved(rollback),
        partyId: supplier2Id,
        validUntil: '2020-01-01',
        items: [],
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { 'header.validUntil': ['报价截止不得早于报价日期'] },
    })
    expect(await quotations.getDraft(actor, 'purchase', rollback.id)).toEqual(before)
  })

  test('报价 replace 仅在新增/删除价格档时追加 create/delete 权限', async () => {
    const created = await quotations.createDraft(
      actor,
      'purchase',
      draftInput('purchase', `${prefix}-PUR-RBAC`),
    )
    const updateOnly = limitedActor('update')

    const pureUpdate = replaceInputFromSaved(created)
    pureUpdate.terms = '仅修改已有快照'
    const purelyUpdated = await quotations.replaceDraft(
      updateOnly,
      'purchase',
      created.id,
      pureUpdate,
    )
    expect(purelyUpdated.terms).toBe('仅修改已有快照')

    const withNewTier = replaceInputFromSaved(purelyUpdated)
    withNewTier.items[1]!.tiers.push({ minQty: '1000', price: '4' })
    await expect(
      quotations.replaceDraft(updateOnly, 'purchase', created.id, withNewTier),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const withCreate = await quotations.replaceDraft(
      limitedActor('update', 'create'),
      'purchase',
      created.id,
      withNewTier,
    )
    expect(withCreate.items[1]?.tiers).toHaveLength(3)

    const withoutAddedTier = replaceInputFromSaved(withCreate)
    withoutAddedTier.items[1]!.tiers = withoutAddedTier.items[1]!.tiers.slice(0, 2)
    await expect(
      quotations.replaceDraft(updateOnly, 'purchase', created.id, withoutAddedTier),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const withDelete = await quotations.replaceDraft(
      limitedActor('update', 'delete'),
      'purchase',
      created.id,
      withoutAddedTier,
    )
    expect(withDelete.items[1]?.tiers).toHaveLength(2)
  })
})
