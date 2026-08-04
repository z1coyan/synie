/**
 * 销售/采购报价审核/作废 PG 集成：flipDocStatusInTx 状态翻转骨架的首个消费方。
 * 覆盖：草稿门、条目非空校验、梯度完整校验、审核人落章、作废回翻、审计留痕。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import type { TradingSide } from '../common.ts'
import { createQuotationService, type QuotationDraftInput } from './service.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（报价审核/作废：状态翻转骨架）', () => {
  const db = createDb(url!)
  const quotations = createQuotationService(db, createNumberingService(db, buildNumberingCatalog(createSealedResourceRegistry())))
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `QA${suffix}`

  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const supplierId = crypto.randomUUID()
  const unitId = crypto.randomUUID()
  const categoryId = crypto.randomUUID()
  const materialId = crypto.randomUUID()

  const actor: Actor = {
    userId: '',
    username: 'quotation-audit-test',
    name: '报价审核测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  }

  function input(side: TradingSide, quotationNo: string): QuotationDraftInput {
    return {
      companyId,
      quotationNo,
      quotationDate: '2026-07-31',
      validUntil: '2026-08-31',
      partyType: side === 'sales' ? 'CUSTOMER' : 'SUPPLIER',
      partyId: side === 'sales' ? customerId : supplierId,
      currencyId,
      terms: null,
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
      ],
    }
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'Q' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'QA', ${currencyId}::uuid)
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
      VALUES (${unitId}::uuid, ${'qa-' + suffix}, true, ${prefix + '件'}, 'u', 1)
    `.execute(db)
    await sql`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES (${categoryId}::uuid, ${'MC' + suffix}, ${prefix + '分类'}, true, true)
    `.execute(db)
    await sql`
      INSERT INTO inv_material(id,code,name,category_id,default_unit_id,active)
      VALUES (${materialId}::uuid, ${'M' + suffix}, ${prefix + '物料'}, ${categoryId}::uuid, ${unitId}::uuid, true)
    `.execute(db)
  })

  afterAll(async () => {
    await sql`DELETE FROM sys_audit_log WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_quotation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM pur_quotation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material WHERE id=${materialId}::uuid`.execute(db)
    await sql`DELETE FROM inv_material_category WHERE id=${categoryId}::uuid`.execute(db)
    await sql`DELETE FROM bas_unit WHERE id=${unitId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM pur_supplier WHERE id=${supplierId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await db.destroy()
  })

  test('销售/采购均走完 草稿→已审核→已作废，审核落章且留审计', async () => {
    for (const side of ['sales', 'purchase'] as const) {
      const created = await quotations.createDraft(actor, side, input(side, `${prefix}-${side}`))
      expect(created.status).toBe('DRAFT')

      const audited = await quotations.auditHead(actor, side, created.id)
      expect(audited.status).toBe('AUDITED')
      expect(audited.auditedAt).not.toBeNull()

      // 重复审核被草稿门拦截
      await expect(quotations.auditHead(actor, side, created.id)).rejects.toThrow(
        /仅草稿报价单可审核/,
      )

      const voided = await quotations.voidHead(actor, side, created.id)
      expect(voided.status).toBe('VOIDED')

      // 重复作废被已审核门拦截
      await expect(quotations.voidHead(actor, side, created.id)).rejects.toThrow(
        /仅已审核报价单可作废/,
      )

      const auditRows = await sql<{ action_name: string }>`
        SELECT action_name FROM sys_audit_log
        WHERE record_id=${created.id}::uuid AND action_name IN ('audit','void')
        ORDER BY inserted_at
      `.execute(db)
      expect(auditRows.rows.map((r) => r.action_name)).toEqual(['audit', 'void'])
    }
  })

  test('空条目报价单不可审核', async () => {
    const created = await quotations.createDraft(actor, 'sales', {
      ...input('sales', `${prefix}-EMPTY`),
      items: [],
    })
    await expect(quotations.auditHead(actor, 'sales', created.id)).rejects.toThrow(
      /审核前必须至少填写一行条目/,
    )
    // 审核失败状态保持草稿
    const head = await sql<{ status: string }>`
      SELECT status FROM sal_quotation WHERE id=${created.id}::uuid
    `.execute(db)
    expect(head.rows[0]?.status).toBe('draft')
  })

  test('数量梯度条目缺价格档不可审核', async () => {
    const created = await quotations.createDraft(actor, 'sales', {
      ...input('sales', `${prefix}-TIERLESS`),
      items: [
        {
          idx: 1,
          materialId,
          unitId,
          pricingMode: 'QTY_TIERED',
          price: null,
          taxRate: '0.13',
          remarks: null,
          tiers: [],
        },
      ],
    })
    await expect(quotations.auditHead(actor, 'sales', created.id)).rejects.toThrow(
      /数量梯度条目必须至少填写一个价格档/,
    )
  })
})
