/**
 * 销售/采购报价 Aggregate Draft PG 集成：完整 HTTP seam 与嵌套写入原子性。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { testActor } from '~/platform/authz/testing.ts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { onError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import type { TradingSide } from '../common.ts'
import { quotationHeadRoutes, quotationItemRoutes, quotationTierRoutes } from './routes.ts'
import {
  createQuotationService,
  type QuotationDraftInput,
  type QuotationSavedDraft,
} from './service.ts'


/** sealed registry 同时供编号（授权归宿解析）与 authz 执行面消费 */
const registry = createSealedResourceRegistry()
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（销售/采购报价 Aggregate Draft）', () => {
  const db = createDb(url!)
  const authz = createAuthzEnforcer(registry)
  const quotations = createQuotationService(
    db,
    createNumberingService(db, buildNumberingCatalog(registry), registry),
    registry,
  )
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `QD${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const otherCompanyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const supplier2Id = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()
  const material2Id = crypto.randomUUID()

  const actor: Actor = testActor({
    userId: '',
    username: 'quotation-draft-test',
    name: '报价聚合草稿测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })
  /** 凭证每次现取（actor 可被改写）；superAdmin 的 rowFilter 恒全集 */
  const permit = (): Permit => permitFor(actor, 'purQuotations', 'read')
  function permitFor(who: Actor, resource: string, action: string): Permit {
    const decision = authz.decideFor(who, resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit：${resource}:${action}`)
    return decision.permit
  }
  const auth = {
    authenticate: async (token: string) => byToken(token),
    authenticateRequest: async (headers: Headers) => {
      const header = headers.get('authorization')
      const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
      return byToken(token)
    },
  } as unknown as AuthService
  const http = new Hono<AppEnv>()
    .route(
      '/api/v1/sales/quotations',
      quotationHeadRoutes({ auth, authz, quotations, side: 'sales' }),
    )
    .route(
      '/api/v1/purchase/quotations',
      quotationHeadRoutes({ auth, authz, quotations, side: 'purchase' }),
    )
    .route(
      '/api/v1/purchase/quotation-items',
      quotationItemRoutes({ auth, authz, quotations, side: 'purchase' }),
    )
    .route(
      '/api/v1/purchase/quotation-tiers',
      quotationTierRoutes({ auth, authz, quotations, side: 'purchase' }),
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

  type QuotationAction = 'read' | 'update' | 'create' | 'delete' | 'audit' | 'void'

  function limitedActor(...actions: QuotationAction[]): Actor {
    return testActor({
      ...actor,
      username: `quotation-${actions.join('-')}`,
      superAdmin: false,
      permissions: new Set(actions.map((action) => `purchase.quotation:${action}`)),
    })
  }

  /** 公司域 actor（非 superAdmin）：superAdmin 的 rowFilter 是 bypass，测不出别名写错 */
  function scopedActor(companies: string[], ...actions: QuotationAction[]): Actor {
    return testActor({
      userId: '',
      username: `quotation-scoped-${companies.length}`,
      superAdmin: false,
      allCompanies: false,
      companyIds: companies,
      permissions: new Set([
        ...actions.map((action) => `purchase.quotation:${action}`),
        ...actions.map((action) => `sales.quotation:${action}`),
      ]),
    })
  }

  const fullActor = limitedActor('read', 'create', 'update', 'delete')
  const updateOnlyActor = limitedActor('read', 'update')
  const noCodeActor = limitedActor()
  const byToken = (token: string | null): Actor => {
    if (token === 'full') return fullActor
    if (token === 'update-only') return updateOnlyActor
    if (token === 'no-code') return noCodeActor
    return actor
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
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'QD', ${currencyId}::uuid),
        (${otherCompanyId}::uuid, ${'D' + suffix}, ${prefix + '他司'}, 'QE', ${currencyId}::uuid)
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
      VALUES (${unitId}::uuid, ${'qd-' + suffix}, true, ${prefix + '件'}, ${'ud' + suffix}, 1)
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
    await sql`
      DELETE FROM bas_company WHERE id IN (${companyId}::uuid, ${otherCompanyId}::uuid)
    `.execute(db)
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
        quotations.createDraft(permit(), side, input),
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
        permit(),
        side,
        draftInput(side, `${prefix}-RR-${side[0]}`),
      )
      const before = await quotations.getDraft(permit(), side, created.id)
      const fixedItem = created.items[0]!
      const tieredItem = created.items[1]!
      const keptTier = tieredItem.tiers[0]!

      await expect(
        quotations.replaceDraft(permit(), side, created.id, {
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

      expect(await quotations.getDraft(permit(), side, created.id)).toEqual(before)
    }
  })

  test('报价全量替换可清空旧条目同时换对手，后续失败会恢复删除', async () => {
    const changed = await quotations.createDraft(
      permit(),
      'purchase',
      draftInput('purchase', `${prefix}-PUR-PARTY-CHANGE`),
    )
    const changedResult = await quotations.replaceDraft(permit(), 'purchase', changed.id, {
      ...replaceInputFromSaved(changed),
      partyId: supplier2Id,
      items: [],
    })
    expect(changedResult.partyId).toBe(supplier2Id)
    expect(changedResult.items).toEqual([])

    const rollback = await quotations.createDraft(
      permit(),
      'purchase',
      draftInput('purchase', `${prefix}-PUR-PARTY-ROLLBACK`),
    )
    const before = await quotations.getDraft(permit(), 'purchase', rollback.id)
    await expect(
      quotations.replaceDraft(permit(), 'purchase', rollback.id, {
        ...replaceInputFromSaved(rollback),
        partyId: supplier2Id,
        validUntil: '2020-01-01',
        items: [],
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      fields: { 'header.validUntil': ['报价截止不得早于报价日期'] },
    })
    expect(await quotations.getDraft(permit(), 'purchase', rollback.id)).toEqual(before)
  })

  /**
   * 语义变化：子树差异（新增/删除条目与档位）的码级门控从服务层动态判定
   * 搬到路由的 `guard(head, 'update', { allOf: [prefix:create, prefix:delete] })`。
   * 服务层拿到凭证即执行（不再抛 forbidden）；缺码在 HTTP 层落 403。
   */
  test('报价 replace 的子树差异不再在服务层判定：拿到凭证即可增删档位', async () => {
    const created = await quotations.createDraft(
      permit(),
      'purchase',
      draftInput('purchase', `${prefix}-PUR-RBAC`),
    )
    const updatePermit = permitFor(updateOnlyActor, 'purQuotations', 'update')

    const pureUpdate = replaceInputFromSaved(created)
    pureUpdate.terms = '仅修改已有快照'
    const purelyUpdated = await quotations.replaceDraft(
      updatePermit,
      'purchase',
      created.id,
      pureUpdate,
    )
    expect(purelyUpdated.terms).toBe('仅修改已有快照')

    // 旧实现在此抛 forbidden（缺 create）；新实现服务层不再判定
    const withNewTier = replaceInputFromSaved(purelyUpdated)
    withNewTier.items[1]!.tiers.push({ minQty: '1000', price: '4' })
    const grown = await quotations.replaceDraft(
      updatePermit,
      'purchase',
      created.id,
      withNewTier,
    )
    expect(grown.items[1]?.tiers).toHaveLength(3)

    // 旧实现在此抛 forbidden（缺 delete）；新实现同样直接执行
    const withoutAddedTier = replaceInputFromSaved(grown)
    withoutAddedTier.items[1]!.tiers = withoutAddedTier.items[1]!.tiers.slice(0, 2)
    const shrunk = await quotations.replaceDraft(
      updatePermit,
      'purchase',
      created.id,
      withoutAddedTier,
    )
    expect(shrunk.items[1]?.tiers).toHaveLength(2)
  })

  test('整单 PUT 缺 create/delete 附加码时 HTTP 层落 403，齐码放行', async () => {
    const headers = { authorization: 'Bearer test', 'content-type': 'application/json' }
    const created = await quotations.createDraft(
      permit(),
      'purchase',
      draftInput('purchase', `${prefix}-PUR-PUT403`),
    )
    const body = JSON.stringify(replaceInputFromSaved(created))

    const denied = await http.request(`/api/v1/purchase/quotations/${created.id}`, {
      method: 'PUT',
      headers: { ...headers, authorization: 'Bearer update-only' },
      body,
    })
    expect(denied.status).toBe(403)

    const allowed = await http.request(`/api/v1/purchase/quotations/${created.id}`, {
      method: 'PUT',
      headers: { ...headers, authorization: 'Bearer full' },
      body,
    })
    expect(allowed.status).toBe(200)
  })

  test('缺码一律 403：头/条目/价格档三组端点（条目与档位经 via 解析到母资源的码）', async () => {
    const headers = { authorization: 'Bearer no-code', 'content-type': 'application/json' }
    const created = await quotations.createDraft(
      permit(),
      'purchase',
      draftInput('purchase', `${prefix}-PUR-403`),
    )
    const tieredItem = created.items[1]!
    const paths = [
      '/api/v1/purchase/quotations/query',
      '/api/v1/purchase/quotation-items/query',
      '/api/v1/purchase/quotation-tiers/query',
    ]
    for (const path of paths) {
      const res = await http.request(path, { method: 'POST', headers, body: '{}' })
      expect(res.status).toBe(403)
    }
    expect(
      (await http.request(`/api/v1/purchase/quotations/${created.id}`, { headers })).status,
    ).toBe(403)
    expect(
      (await http.request(`/api/v1/purchase/quotation-items/${tieredItem.id}`, { headers }))
        .status,
    ).toBe(403)
    expect(
      (await http.request(
        `/api/v1/purchase/quotation-tiers/${tieredItem.tiers[0]!.id}`,
        { headers },
      )).status,
    ).toBe(403)
    // 有 read 码时同样的条目/档位端点放行：403 只由「码不满足」产生
    const readHeaders = { authorization: 'Bearer full' }
    expect(
      (await http.request(`/api/v1/purchase/quotation-items/${tieredItem.id}`, {
        headers: readHeaders,
      })).status,
    ).toBe(200)
  })

  /**
   * 别名回归：listAuthorized/loadAuthorizedFrom 的 alias 必须与 source 子查询别名逐字一致，
   * 写错不 typecheck。superAdmin 的 rowFilter 是 bypass（编译成 true），测不出来——
   * 故一律用公司域 actor，并断言「本公司的行在结果里」。
   */
  test('别名回归：公司域 actor 能在头/条目/价格档三条列表路径看到本公司的行', async () => {
    const no = `${prefix}-PUR-ALIAS`
    const created = await quotations.createDraft(permit(), 'purchase', draftInput('purchase', no))
    const tieredItem = created.items[1]!
    const scoped = permitFor(scopedActor([companyId], 'read'), 'purQuotations', 'read')

    const heads = await quotations.listHeads(scoped, 'purchase', {
      limit: 200,
      filter: { quotationNo: { kind: 'text', op: 'eq', value: no } },
    })
    expect(heads.results.map((r) => r.id)).toContain(created.id)

    const items = await quotations.listItems(scoped, 'purchase', {
      limit: 200,
      filter: { quotationId: { kind: 'fk', op: 'in', values: [created.id], labels: [] } },
    })
    expect(items.results.map((r) => r.id)).toContain(tieredItem.id)

    const tiers = await quotations.listTiers(scoped, 'purchase', {
      limit: 200,
      filter: { itemId: { kind: 'fk', op: 'in', values: [tieredItem.id], labels: [] } },
    })
    expect(tiers.results.map((r) => r.id)).toContain(tieredItem.tiers[0]!.id)

    // 单条读同样经过 via 链（条目/档位递归母单谓词）
    expect((await quotations.getHead(scoped, 'purchase', created.id)).id).toBe(created.id)
    expect((await quotations.getItem(scoped, 'purchase', tieredItem.id)).id).toBe(tieredItem.id)
    expect(
      (await quotations.getTier(scoped, 'purchase', tieredItem.tiers[0]!.id)).id,
    ).toBe(tieredItem.tiers[0]!.id)
  })

  test('跨公司单条一律 404（头/条目/价格档），列表为空集', async () => {
    const no = `${prefix}-PUR-XCOMP`
    const created = await quotations.createDraft(permit(), 'purchase', draftInput('purchase', no))
    const tieredItem = created.items[1]!
    const outsider = permitFor(scopedActor([otherCompanyId], 'read'), 'purQuotations', 'read')

    await expect(
      quotations.getHead(outsider, 'purchase', created.id),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      quotations.getItem(outsider, 'purchase', tieredItem.id),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      quotations.getTier(outsider, 'purchase', tieredItem.tiers[0]!.id),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      quotations.getDraft(outsider, 'purchase', created.id),
    ).rejects.toMatchObject({ code: 'not_found' })

    const heads = await quotations.listHeads(outsider, 'purchase', {
      limit: 200,
      filter: { quotationNo: { kind: 'text', op: 'eq', value: no } },
    })
    expect(heads.results).toEqual([])
    expect(heads.count).toBe(0)
  })

  test('create 的公司边界：目标公司未授权落 404（不再是 forbidden）', async () => {
    const outsider = permitFor(scopedActor([otherCompanyId], 'create'), 'purQuotations', 'create')
    await expect(
      quotations.createDraft(
        outsider,
        'purchase',
        draftInput('purchase', `${prefix}-PUR-CGATE`),
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  test('状态守卫仍是领域不变量：已审核报价单整单替换落 409', async () => {
    const created = await quotations.createDraft(
      permit(),
      'purchase',
      draftInput('purchase', `${prefix}-PUR-409`),
    )
    await quotations.auditHead(permit(), 'purchase', created.id)
    await expect(
      quotations.replaceDraft(
        permit(),
        'purchase',
        created.id,
        replaceInputFromSaved(created),
      ),
    ).rejects.toMatchObject({ code: 'conflict', message: '仅草稿报价单可修改或删除' })
  })
})
