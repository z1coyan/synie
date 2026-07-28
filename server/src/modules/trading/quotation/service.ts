/**
 * 销售/采购报价单：头/条目/价格档 + 订单套档解析。
 * 行为对齐 server-go/internal/domain/trading/quotation。
 */
import type { ListQuery } from '@synie/shared'
import { decimal, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { canAccessCompany } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { companyScopeWhere, listFromSource } from '../../base/list.ts'
import { mapWriteError } from '../../base/dberr.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  codeNamedRef,
  guardCustomerMaterial,
  ident,
  loadMaterialSnap,
  lowerParty,
  namedRef,
  partyExists,
  requireCompanyAccess,
  requirePerm,
  runeLen,
  todayUTC,
  toDateOnly,
  type TradingSide,
  upperStatus,
  wireDecimal,
  wireRequiredDecimal,
} from '../common.ts'
import {
  quotationHeadMeta,
  quotationItemMeta,
  quotationSpec,
  quotationTierMeta,
  type QuotationSideSpec,
} from './spec.ts'

const HEAD_AUDIT = [
  'quotation_no',
  'quotation_date',
  'valid_until',
  'party_type',
  'party_id',
  'terms',
  'remarks',
  'status',
  'audited_at',
  'company_id',
  'currency_id',
  'created_by_id',
  'audited_by_id',
] as const

const ITEM_AUDIT = [
  'idx',
  'pricing_mode',
  'price',
  'tax_rate',
  'material_code',
  'material_name',
  'material_spec',
  'customer_part_no',
  'unit_name',
  'remarks',
  'quotation_id',
  'company_id',
  'material_id',
  'unit_id',
] as const

const TIER_AUDIT = ['min_qty', 'price', 'item_id', 'company_id'] as const

export interface Quotation {
  id: string
  quotationNo: string
  quotationDate: string
  validUntil: string
  partyType: string
  partyId: string
  terms: string | null
  remarks: string | null
  status: string
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  currencyId: string
  createdById: string | null
  auditedById: string | null
  company: { id: string; name: string }
  currency: { id: string; code: string; name: string }
  createdBy: { id: string; name: string } | null
  auditedBy: { id: string; name: string } | null
}

export interface QuotationItem {
  id: string
  idx: number
  pricingMode: string
  price: string | null
  taxRate: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  insertedAt: string
  updatedAt: string
  quotationId: string
  companyId: string
  materialId: string
  unitId: string
  tierCount: number
  quotationDate: string
  validUntil: string
  quotationStatus: string
  partyType: string
  partyId: string
  currencyCode: string
  quotation: { id: string; quotationNo: string }
  company: { id: string; name: string }
  material: { id: string; code: string; name: string }
  unit: { id: string; name: string }
}

export interface QuotationTier {
  id: string
  minQty: string
  price: string
  insertedAt: string
  updatedAt: string
  itemId: string
  companyId: string
  company: { id: string; name: string }
}

export interface ResolveOrderInput {
  quotationItemId: string
  orderDate: string
  companyId: string
  partyType: string
  partyId: string
  currencyId: string
  qty: Decimal | string
}

export interface ResolveOrderResult {
  materialId: string
  unitId: string
  price: Decimal
  taxRate: Decimal
}

type Numberer = Pick<NumberingService, 'nextInTx'>

export function createQuotationService(db: Kysely<Database>, numberer: Numberer) {
  async function listHeads(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该报价操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Quotation[] }
    return listFromSource({
      db,
      resource: quotationHeadMeta(side),
      source: sql` FROM (
        SELECT q.id,q.quotation_no,q.quotation_date,q.valid_until,q.party_type,q.party_id,
          q.terms,q.remarks,q.status,q.audited_at,q.inserted_at,q.updated_at,q.company_id,
          q.currency_id,q.created_by_id,q.audited_by_id,c.name AS company_name,
          cur.iso_code AS currency_code,cur.name AS currency_name,
          creator.name AS created_by_name,auditor.name AS audited_by_name
        FROM ${ident(spec.headTable)} q
        JOIN bas_company c ON c.id=q.company_id
        JOIN bas_currency cur ON cur.id=q.currency_id
        LEFT JOIN sys_user creator ON creator.id=q.created_by_id
        LEFT JOIN sys_user auditor ON auditor.id=q.audited_by_id
      ) quotation_heads`,
      select: sql`SELECT id,quotation_no,quotation_date,valid_until,party_type,party_id,terms,remarks,
        status,audited_at,inserted_at,updated_at,company_id,currency_id,created_by_id,audited_by_id,
        company_name,currency_code,currency_name,created_by_name,audited_by_name`,
      defaultOrder: sql`"quotation_date" DESC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapHead(r),
    })
  }

  async function getHead(actor: Actor, side: TradingSide, id: string): Promise<Quotation> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该报价操作')
    const row = await loadHeadRow(db, spec, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', `${spec.label}不存在`)
    }
    return mapHead(row)
  }

  async function createHead(
    actor: Actor,
    side: TradingSide,
    input: {
      companyId: string
      quotationNo?: string | null
      quotationDate?: string | null
      validUntil: string
      partyType: string
      partyId: string
      currencyId?: string | null
      terms?: string | null
      remarks?: string | null
    },
  ): Promise<Quotation> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该报价操作')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权在该公司下操作数据')
    }
    return withTx(db, async (trx) => {
      const company = await trx
        .selectFrom('bas_company')
        .select(['id', 'base_currency_id'])
        .where('id', '=', input.companyId)
        .executeTakeFirst()
      if (!company) {
        throw ApiError.validation('报价参数不合法', { companyId: ['公司不存在'] })
      }
      const currencyId = input.currencyId ?? company.base_currency_id
      const quotationDate = input.quotationDate ? toDateOnly(input.quotationDate) : todayUTC()
      let quotationNo = (input.quotationNo ?? '').trim()
      if (!quotationNo) {
        quotationNo = await numberer.nextInTx(trx, {
          resource: spec.prefix,
          values: {
            company_id: input.companyId,
            quotation_date: quotationDate,
            valid_until: toDateOnly(input.validUntil),
            party_type: lowerParty(input.partyType),
            party_id: input.partyId,
            currency_id: currencyId,
          },
        })
      }
      const partyType = lowerParty(input.partyType)
      validateHeadShape(spec, {
        quotationNo,
        quotationDate,
        validUntil: toDateOnly(input.validUntil),
        partyType,
        partyId: input.partyId,
        companyId: input.companyId,
        currencyId,
        remarks: input.remarks ?? null,
      })
      if (!(await partyExists(trx, partyType, input.partyId))) {
        throw ApiError.validation('报价参数不合法', { partyId: ['对手不存在'] })
      }
      const createdById = actor.userId || null
      try {
        const inserted = await sql<{ id: string }>`
          INSERT INTO ${ident(spec.headTable)} (
            quotation_no,quotation_date,valid_until,party_type,party_id,terms,remarks,
            company_id,currency_id,created_by_id
          ) VALUES (
            ${quotationNo},${quotationDate}::date,${toDateOnly(input.validUntil)}::date,
            ${partyType},${input.partyId}::uuid,${input.terms ?? null},${input.remarks ?? null},
            ${input.companyId}::uuid,${currencyId}::uuid,${createdById}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = inserted.rows[0]!.id
        const row = await loadHeadRow(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headAudit,
          recordId: id,
          recordLabel: item.quotationNo,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(headSnap(item), HEAD_AUDIT),
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('创建报价单失败', err)
      }
    })
  }

  async function updateHead(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: {
      quotationNo?: string
      quotationDate?: string
      validUntil?: string
      partyType?: string
      partyId?: string
      currencyId?: string
      terms?: string | null
      termsPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Quotation> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该报价操作')
    return withTx(db, async (trx) => {
      const locked = await lockDraftHead(trx, actor, spec, id, '')
      const before = mapHead(locked)
      const after: Quotation = {
        ...before,
        quotationNo: input.quotationNo !== undefined ? input.quotationNo.trim() : before.quotationNo,
        quotationDate: input.quotationDate
          ? toDateOnly(input.quotationDate)
          : before.quotationDate,
        validUntil: input.validUntil ? toDateOnly(input.validUntil) : before.validUntil,
        partyType: input.partyType
          ? input.partyType.trim().toUpperCase()
          : before.partyType,
        partyId: input.partyId ?? before.partyId,
        currencyId: input.currencyId ?? before.currencyId,
        terms: input.termsPresent ? (input.terms ?? null) : before.terms,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      }
      const headChanged =
        lowerParty(after.partyType) !== lowerParty(before.partyType) ||
        after.partyId !== before.partyId ||
        after.currencyId !== before.currencyId
      if (headChanged) {
        const has = await sql<{ e: boolean }>`
          SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE quotation_id=${id}::uuid) AS e
        `.execute(trx)
        if (has.rows[0]?.e) {
          throw new ApiError('conflict', '请先删除报价条目')
        }
      }
      validateHeadShape(spec, {
        quotationNo: after.quotationNo,
        quotationDate: after.quotationDate,
        validUntil: after.validUntil,
        partyType: lowerParty(after.partyType),
        partyId: after.partyId,
        companyId: after.companyId,
        currencyId: after.currencyId,
        remarks: after.remarks,
      })
      if (!(await partyExists(trx, after.partyType, after.partyId))) {
        throw ApiError.validation('报价参数不合法', { partyId: ['对手不存在'] })
      }
      const changes = auditDiff(headSnap(before), headSnap(after), HEAD_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE ${ident(spec.headTable)} SET
            quotation_no=${after.quotationNo},
            quotation_date=${after.quotationDate}::date,
            valid_until=${after.validUntil}::date,
            party_type=${lowerParty(after.partyType)},
            party_id=${after.partyId}::uuid,
            currency_id=${after.currencyId}::uuid,
            terms=${after.terms},
            remarks=${after.remarks},
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const row = await loadHeadRow(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headAudit,
          recordId: id,
          recordLabel: item.quotationNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('更新报价单失败', err)
      }
    })
  }

  async function deleteHead(actor: Actor, side: TradingSide, id: string): Promise<void> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该报价操作')
    await withTx(db, async (trx) => {
      const locked = await lockDraftHead(trx, actor, spec, id, '')
      const item = mapHead(locked)
      await writeAudit(trx, actor, {
        resource: spec.headAudit,
        recordId: id,
        recordLabel: item.quotationNo,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(headSnap(item), HEAD_AUDIT),
      })
      try {
        await sql`DELETE FROM ${ident(spec.headTable)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapQuotationWrite('删除报价单失败', err)
      }
    })
  }

  async function auditHead(actor: Actor, side: TradingSide, id: string): Promise<Quotation> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'audit', '无权限执行该报价操作')
    return withTx(db, async (trx) => {
      const locked = await lockHead(trx, actor, spec, id)
      if (String(locked.status).toLowerCase() !== 'draft') {
        throw new ApiError('conflict', '仅草稿报价单可审核')
      }
      const count = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM ${ident(spec.itemTable)} WHERE quotation_id=${id}::uuid
      `.execute(trx)
      if (Number(count.rows[0]?.c ?? 0) === 0) {
        throw new ApiError('conflict', '审核前必须至少填写一行条目')
      }
      const missing = await sql<{ e: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM ${ident(spec.itemTable)} i
          WHERE i.quotation_id=${id}::uuid AND i.pricing_mode='qty_tiered'
            AND NOT EXISTS(SELECT 1 FROM ${ident(spec.tierTable)} t WHERE t.item_id=i.id)
        ) AS e
      `.execute(trx)
      if (missing.rows[0]?.e) {
        throw new ApiError('conflict', '数量梯度条目必须至少填写一个价格档')
      }
      const before = mapHead(locked)
      const auditedById = actor.userId || null
      try {
        await sql`
          UPDATE ${ident(spec.headTable)} SET
            status='audited',
            audited_at=(now() AT TIME ZONE 'utc'),
            audited_by_id=${auditedById}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const row = await loadHeadRow(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headAudit,
          recordId: id,
          recordLabel: item.quotationNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'audit',
          changes: auditDiff(headSnap(before), headSnap(item), HEAD_AUDIT),
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('审核报价单失败', err)
      }
    })
  }

  async function voidHead(actor: Actor, side: TradingSide, id: string): Promise<Quotation> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'void', '无权限执行该报价操作')
    return withTx(db, async (trx) => {
      const locked = await lockHead(trx, actor, spec, id)
      if (String(locked.status).toLowerCase() !== 'audited') {
        throw new ApiError('conflict', '仅已审核报价单可作废')
      }
      const before = mapHead(locked)
      try {
        await sql`
          UPDATE ${ident(spec.headTable)} SET
            status='voided', updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const row = await loadHeadRow(trx, spec, id)
        const item = mapHead(row!)
        await writeAudit(trx, actor, {
          resource: spec.headAudit,
          recordId: id,
          recordLabel: item.quotationNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'void',
          changes: auditDiff(headSnap(before), headSnap(item), HEAD_AUDIT),
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('作废报价单失败', err)
      }
    })
  }

  async function listItems(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该报价操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as QuotationItem[] }
    return listFromSource({
      db,
      resource: quotationItemMeta(side),
      source: sql` FROM (
        SELECT i.id,i.idx,i.pricing_mode,i.price,i.tax_rate,i.material_code,i.material_name,
          i.material_spec,i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,
          i.quotation_id,i.company_id,i.material_id,i.unit_id,
          (SELECT count(*) FROM ${ident(spec.tierTable)} t WHERE t.item_id=i.id)::bigint AS tier_count,
          q.quotation_date,q.valid_until,q.status AS quotation_status,q.party_type,q.party_id,
          cur.iso_code AS currency_code,q.currency_id,q.quotation_no,c.name AS company_name,
          m.name AS material_live_name,u.name AS unit_live_name
        FROM ${ident(spec.itemTable)} i
        JOIN ${ident(spec.headTable)} q ON q.id=i.quotation_id
        JOIN bas_company c ON c.id=i.company_id
        JOIN bas_currency cur ON cur.id=q.currency_id
        JOIN inv_material m ON m.id=i.material_id
        JOIN bas_unit u ON u.id=i.unit_id
      ) quotation_items`,
      select: sql`SELECT id,idx,pricing_mode,price,tax_rate,material_code,material_name,material_spec,
        customer_part_no,unit_name,remarks,inserted_at,updated_at,quotation_id,company_id,material_id,
        unit_id,tier_count,quotation_date,valid_until,quotation_status,party_type,party_id,currency_code,
        currency_id,quotation_no,company_name,material_live_name,unit_live_name`,
      defaultOrder: sql`"quotation_date" DESC, "idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapItem(r),
    })
  }

  async function getItem(actor: Actor, side: TradingSide, id: string): Promise<QuotationItem> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该报价操作')
    const row = await loadItemRow(db, spec, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '报价条目不存在')
    }
    return mapItem(row)
  }

  async function createItem(
    actor: Actor,
    side: TradingSide,
    input: {
      quotationId: string
      idx: number
      materialId: string
      unitId: string
      pricingMode?: string
      price?: string | null
      taxRate?: string | null
      remarks?: string | null
    },
  ): Promise<QuotationItem> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该报价操作')
    return withTx(db, async (trx) => {
      const parent = await lockDraftHead(trx, actor, spec, input.quotationId, 'item')
      const { mode, price, taxRate } = normalizeItemShape(
        input.pricingMode,
        input.price,
        input.taxRate,
        input.materialId,
        input.unitId,
        input.remarks,
      )
      const snap = await loadMaterialSnap(trx, input.materialId, input.unitId)
      if (spec.customerMaterialGuard) {
        guardCustomerMaterial(
          side,
          String(parent.party_type),
          String(parent.party_id),
          snap,
        )
      }
      try {
        const inserted = await sql<{ id: string }>`
          INSERT INTO ${ident(spec.itemTable)} (
            idx,pricing_mode,price,tax_rate,material_code,material_name,material_spec,
            customer_part_no,unit_name,remarks,quotation_id,company_id,material_id,unit_id
          ) VALUES (
            ${input.idx},${mode.toLowerCase()},${price !== null ? wireRequiredDecimal(price) : null},
            ${wireRequiredDecimal(taxRate)},${snap.code},${snap.name},${snap.spec},
            ${snap.customerPartNo},${snap.unitName},${input.remarks ?? null},
            ${input.quotationId}::uuid,${String(parent.company_id)}::uuid,
            ${input.materialId}::uuid,${input.unitId}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = inserted.rows[0]!.id
        const row = await loadItemRow(trx, spec, id)
        const item = mapItem(row!)
        await writeAudit(trx, actor, {
          resource: spec.itemAudit,
          recordId: id,
          recordLabel: String(item.idx),
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(itemSnap(item), ITEM_AUDIT),
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('创建报价条目失败', err)
      }
    })
  }

  async function updateItem(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: {
      idx?: number
      materialId?: string
      unitId?: string
      pricingMode?: string
      price?: string | null
      pricePresent?: boolean
      taxRate?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<QuotationItem> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该报价操作')
    return withTx(db, async (trx) => {
      const existing = await sql<{ quotation_id: string }>`
        SELECT quotation_id FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!existing.rows[0]) throw new ApiError('not_found', '报价条目不存在')
      const parent = await lockDraftHead(
        trx,
        actor,
        spec,
        existing.rows[0].quotation_id,
        'item',
      )
      const beforeRow = await loadItemRow(trx, spec, id)
      if (!beforeRow) throw new ApiError('not_found', '报价条目不存在')
      const before = mapItem(beforeRow)
      const afterMode = input.pricingMode ?? before.pricingMode
      const afterPrice = input.pricePresent
        ? input.price
        : before.price
      const { mode, price, taxRate } = normalizeItemShape(
        afterMode,
        afterPrice,
        input.taxRate ?? before.taxRate,
        input.materialId ?? before.materialId,
        input.unitId ?? before.unitId,
        input.remarksPresent ? input.remarks : before.remarks,
      )
      const materialId = input.materialId ?? before.materialId
      const unitId = input.unitId ?? before.unitId
      const snap = await loadMaterialSnap(trx, materialId, unitId)
      if (spec.customerMaterialGuard) {
        guardCustomerMaterial(side, String(parent.party_type), String(parent.party_id), snap)
      }
      const after: QuotationItem = {
        ...before,
        idx: input.idx ?? before.idx,
        pricingMode: mode,
        price: price !== null ? wireRequiredDecimal(price) : null,
        taxRate: wireRequiredDecimal(taxRate),
        materialId,
        unitId,
        materialCode: snap.code,
        materialName: snap.name,
        materialSpec: snap.spec,
        customerPartNo: snap.customerPartNo,
        unitName: snap.unitName,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      }
      const changes = auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE ${ident(spec.itemTable)} SET
            idx=${after.idx}, pricing_mode=${mode.toLowerCase()},
            price=${after.price}, tax_rate=${after.taxRate},
            material_code=${after.materialCode}, material_name=${after.materialName},
            material_spec=${after.materialSpec}, customer_part_no=${after.customerPartNo},
            unit_name=${after.unitName}, remarks=${after.remarks},
            material_id=${after.materialId}::uuid, unit_id=${after.unitId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        if (before.pricingMode === 'QTY_TIERED' && mode === 'FIXED') {
          await purgeTiers(trx, actor, spec, id)
        }
        const row = await loadItemRow(trx, spec, id)
        const item = mapItem(row!)
        await writeAudit(trx, actor, {
          resource: spec.itemAudit,
          recordId: id,
          recordLabel: String(item.idx),
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('更新报价条目失败', err)
      }
    })
  }

  async function deleteItem(actor: Actor, side: TradingSide, id: string): Promise<void> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该报价操作')
    await withTx(db, async (trx) => {
      const existing = await sql<{ quotation_id: string }>`
        SELECT quotation_id FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid
      `.execute(trx)
      if (!existing.rows[0]) throw new ApiError('not_found', '报价条目不存在')
      await lockDraftHead(trx, actor, spec, existing.rows[0].quotation_id, 'item')
      const row = await loadItemRow(trx, spec, id)
      if (!row) throw new ApiError('not_found', '报价条目不存在')
      const item = mapItem(row)
      await writeAudit(trx, actor, {
        resource: spec.itemAudit,
        recordId: id,
        recordLabel: String(item.idx),
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(itemSnap(item), ITEM_AUDIT),
      })
      try {
        await sql`DELETE FROM ${ident(spec.itemTable)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapQuotationWrite('删除报价条目失败', err)
      }
    })
  }

  async function listTiers(actor: Actor, side: TradingSide, query: Partial<ListQuery>) {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该报价操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as QuotationTier[] }
    return listFromSource({
      db,
      resource: quotationTierMeta(side),
      source: sql` FROM (
        SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
          c.name AS company_name
        FROM ${ident(spec.tierTable)} t
        JOIN bas_company c ON c.id=t.company_id
      ) quotation_tiers`,
      select: sql`SELECT id,min_qty,price,inserted_at,updated_at,item_id,company_id,company_name`,
      defaultOrder: sql`"min_qty" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapTier(r),
    })
  }

  async function getTier(actor: Actor, side: TradingSide, id: string): Promise<QuotationTier> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'read', '无权限执行该报价操作')
    const row = await loadTierRow(db, spec, id)
    if (!row || !canAccessCompany(actor, String(row.company_id))) {
      throw new ApiError('not_found', '报价价格档不存在')
    }
    return mapTier(row)
  }

  async function createTier(
    actor: Actor,
    side: TradingSide,
    input: { itemId: string; minQty: string; price: string },
  ): Promise<QuotationTier> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'create', '无权限执行该报价操作')
    const minQty = decimal(input.minQty)
    const price = decimal(input.price)
    validateTierShape(minQty, price)
    return withTx(db, async (trx) => {
      const parent = await tierParent(trx, spec, input.itemId)
      await lockDraftHead(trx, actor, spec, parent.quotationId, 'tier')
      if (parent.mode !== 'qty_tiered') {
        throw ApiError.validation('报价价格档参数不合法', {
          itemId: ['仅数量梯度条目可维护价格档'],
        })
      }
      try {
        const inserted = await sql<{ id: string }>`
          INSERT INTO ${ident(spec.tierTable)} (min_qty,price,item_id,company_id)
          VALUES (${wireRequiredDecimal(minQty)},${wireRequiredDecimal(price)},
            ${input.itemId}::uuid,${parent.companyId}::uuid)
          RETURNING id
        `.execute(trx)
        const id = inserted.rows[0]!.id
        const row = await loadTierRow(trx, spec, id)
        const item = mapTier(row!)
        await writeAudit(trx, actor, {
          resource: spec.tierAudit,
          recordId: id,
          recordLabel: item.minQty,
          companyId: item.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(tierSnap(item), TIER_AUDIT),
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('创建报价价格档失败', err)
      }
    })
  }

  async function updateTier(
    actor: Actor,
    side: TradingSide,
    id: string,
    input: { minQty?: string; price?: string },
  ): Promise<QuotationTier> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'update', '无权限执行该报价操作')
    return withTx(db, async (trx) => {
      const beforeRow = await loadTierRow(trx, spec, id)
      if (!beforeRow) throw new ApiError('not_found', '报价价格档不存在')
      const parent = await tierParent(trx, spec, String(beforeRow.item_id))
      await lockDraftHead(trx, actor, spec, parent.quotationId, 'tier')
      if (parent.mode !== 'qty_tiered') {
        throw ApiError.validation('报价价格档参数不合法', {
          itemId: ['仅数量梯度条目可维护价格档'],
        })
      }
      const before = mapTier(beforeRow)
      const after: QuotationTier = {
        ...before,
        minQty: input.minQty !== undefined ? wireRequiredDecimal(input.minQty) : before.minQty,
        price: input.price !== undefined ? wireRequiredDecimal(input.price) : before.price,
      }
      validateTierShape(decimal(after.minQty), decimal(after.price))
      const changes = auditDiff(tierSnap(before), tierSnap(after), TIER_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE ${ident(spec.tierTable)} SET
            min_qty=${after.minQty}, price=${after.price},
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const row = await loadTierRow(trx, spec, id)
        const item = mapTier(row!)
        await writeAudit(trx, actor, {
          resource: spec.tierAudit,
          recordId: id,
          recordLabel: item.minQty,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        throw mapQuotationWrite('更新报价价格档失败', err)
      }
    })
  }

  async function deleteTier(actor: Actor, side: TradingSide, id: string): Promise<void> {
    const spec = quotationSpec(side)
    requirePerm(actor, spec.prefix, 'delete', '无权限执行该报价操作')
    await withTx(db, async (trx) => {
      const row = await loadTierRow(trx, spec, id)
      if (!row) throw new ApiError('not_found', '报价价格档不存在')
      const parent = await tierParent(trx, spec, String(row.item_id))
      await lockDraftHead(trx, actor, spec, parent.quotationId, 'tier')
      if (parent.mode !== 'qty_tiered') {
        throw ApiError.validation('报价价格档参数不合法', {
          itemId: ['仅数量梯度条目可维护价格档'],
        })
      }
      const item = mapTier(row)
      await writeAudit(trx, actor, {
        resource: spec.tierAudit,
        recordId: id,
        recordLabel: item.minQty,
        companyId: item.companyId,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(tierSnap(item), TIER_AUDIT),
      })
      try {
        await sql`DELETE FROM ${ident(spec.tierTable)} WHERE id=${id}::uuid`.execute(trx)
      } catch (err) {
        throw mapQuotationWrite('删除报价价格档失败', err)
      }
    })
  }

  /**
   * 订单行套档：调用方已持订单头锁；本函数锁定报价头并校验有效期/公司/对手/币种。
   */
  async function resolveForOrder(
    trx: DbHandle,
    side: TradingSide,
    input: ResolveOrderInput,
  ): Promise<ResolveOrderResult> {
    const spec = quotationSpec(side)
    const rows = await sql<{
      material_id: string
      unit_id: string
      pricing_mode: string
      price: string | null
      tax_rate: string
      quotation_date: string
      valid_until: string
      status: string
      company_id: string
      party_type: string
      party_id: string
      currency_id: string
    }>`
      SELECT i.material_id,i.unit_id,i.pricing_mode,i.price::text AS price,i.tax_rate::text AS tax_rate,
        q.quotation_date::text AS quotation_date,q.valid_until::text AS valid_until,q.status,
        q.company_id,q.party_type,q.party_id,q.currency_id
      FROM ${ident(spec.itemTable)} i
      JOIN ${ident(spec.headTable)} q ON q.id=i.quotation_id
      WHERE i.id=${input.quotationItemId}::uuid
      FOR UPDATE OF q
    `.execute(trx)
    const row = rows.rows[0]
    if (!row) {
      throw ApiError.validation('订单条目参数不合法', {
        quotationItemId: ['报价条目不存在'],
      })
    }
    const orderDate = toDateOnly(input.orderDate)
    if (row.status.toLowerCase() !== 'audited') {
      throw new ApiError('conflict', '报价单须为已审核状态')
    }
    const qDate = asDate(row.quotation_date)
    const vUntil = asDate(row.valid_until)
    if (orderDate < qDate || orderDate > vUntil) {
      throw new ApiError('conflict', '订单日期不在报价有效期内')
    }
    if (row.company_id !== input.companyId) {
      throw new ApiError('conflict', '报价公司与订单不一致')
    }
    if (
      row.party_type !== lowerParty(input.partyType) ||
      row.party_id !== input.partyId
    ) {
      throw new ApiError('conflict', '报价对手与订单不一致')
    }
    if (row.currency_id !== input.currencyId) {
      throw new ApiError('conflict', '报价币种与订单不一致')
    }
    const taxRate = decimal(row.tax_rate)
    const mode = row.pricing_mode.toLowerCase()
    if (mode === 'fixed') {
      if (row.price === null) throw new ApiError('conflict', '固定价报价缺少单价')
      return {
        materialId: row.material_id,
        unitId: row.unit_id,
        price: decimal(row.price),
        taxRate,
      }
    }
    if (mode === 'qty_tiered') {
      const tier = await sql<{ price: string }>`
        SELECT price::text AS price FROM ${ident(spec.tierTable)}
        WHERE item_id=${input.quotationItemId}::uuid AND min_qty <= ${wireRequiredDecimal(input.qty)}
        ORDER BY min_qty DESC LIMIT 1
      `.execute(trx)
      if (!tier.rows[0]) {
        throw new ApiError('conflict', '数量低于首档起订量,无可用报价')
      }
      return {
        materialId: row.material_id,
        unitId: row.unit_id,
        price: decimal(tier.rows[0].price),
        taxRate,
      }
    }
    throw new ApiError('conflict', '报价定价模式不合法')
  }

  return {
    listHeads,
    getHead,
    createHead,
    updateHead,
    deleteHead,
    auditHead,
    voidHead,
    listItems,
    getItem,
    createItem,
    updateItem,
    deleteItem,
    listTiers,
    getTier,
    createTier,
    updateTier,
    deleteTier,
    resolveForOrder,
  }
}

export type QuotationService = ReturnType<typeof createQuotationService>

function validateHeadShape(
  spec: QuotationSideSpec,
  v: {
    quotationNo: string
    quotationDate: string
    validUntil: string
    partyType: string
    partyId: string
    companyId: string
    currencyId: string
    remarks: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!v.quotationNo || runeLen(v.quotationNo) > 32) {
    fields.quotationNo = ['不能为空且最多 32 个字符']
  }
  if (!v.quotationDate) fields.quotationDate = ['必填']
  if (!v.validUntil) fields.validUntil = ['必填']
  else if (v.quotationDate && v.validUntil < v.quotationDate) {
    fields.validUntil = ['报价截止不得早于报价日期']
  }
  if (!spec.allowedParty.has(lowerParty(v.partyType))) {
    fields.partyType =
      spec.side === 'sales'
        ? ['对手类型只能为客户或内部公司']
        : ['对手类型只能为供应商或内部公司']
  }
  if (!v.partyId) fields.partyId = ['必填']
  if (!v.companyId) fields.companyId = ['必填']
  if (!v.currencyId) fields.currencyId = ['必填']
  if (lowerParty(v.partyType) === 'company' && v.partyId === v.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (v.remarks && runeLen(v.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

function normalizeItemShape(
  modeRaw: string | undefined,
  priceRaw: string | null | undefined,
  taxRateRaw: string | null | undefined,
  materialId: string,
  unitId: string,
  remarks: string | null | undefined,
): { mode: string; price: Decimal | null; taxRate: Decimal } {
  let mode = (modeRaw ?? 'FIXED').trim().toUpperCase()
  if (!mode) mode = 'FIXED'
  let taxRate = decimal('0.13')
  if (taxRateRaw !== null && taxRateRaw !== undefined && taxRateRaw !== '') {
    taxRate = decimal(taxRateRaw)
  }
  const fields: Record<string, string[]> = {}
  let price: Decimal | null = null
  if (mode === 'FIXED') {
    if (priceRaw === null || priceRaw === undefined || priceRaw === '') {
      fields.price = ['固定价条目必须填写含税单价']
    } else {
      price = decimal(priceRaw)
      if (price.isNegative()) fields.price = ['含税单价不能为负']
    }
  } else if (mode === 'QTY_TIERED') {
    price = null
  } else {
    fields.pricingMode = ['只能为 FIXED 或 QTY_TIERED']
  }
  if (taxRate.isNegative() || taxRate.gte(1)) {
    fields.taxRate = ['税率必须在 0(含)与 1 之间']
  }
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价条目参数不合法', fields)
  }
  return { mode, price, taxRate }
}

function validateTierShape(minQty: Decimal, price: Decimal) {
  const fields: Record<string, string[]> = {}
  if (!minQty.isPositive()) fields.minQty = ['起订量必须大于零']
  if (price.isNegative()) fields.price = ['含税档价不能为负']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价价格档参数不合法', fields)
  }
}

async function lockHead(
  db: DbHandle,
  actor: Actor,
  spec: QuotationSideSpec,
  id: string,
): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>>`
    SELECT q.id,q.quotation_no,q.quotation_date,q.valid_until,q.party_type,q.party_id,
      q.terms,q.remarks,q.status,q.audited_at,q.inserted_at,q.updated_at,q.company_id,
      q.currency_id,q.created_by_id,q.audited_by_id,c.name AS company_name,
      cur.iso_code AS currency_code,cur.name AS currency_name,
      creator.name AS created_by_name,auditor.name AS audited_by_name
    FROM ${ident(spec.headTable)} q
    JOIN bas_company c ON c.id=q.company_id
    JOIN bas_currency cur ON cur.id=q.currency_id
    LEFT JOIN sys_user creator ON creator.id=q.created_by_id
    LEFT JOIN sys_user auditor ON auditor.id=q.audited_by_id
    WHERE q.id=${id}::uuid
    FOR UPDATE OF q
  `.execute(db)
  const row = rows.rows[0]
  if (!row || !canAccessCompany(actor, String(row.company_id))) {
    throw new ApiError('not_found', `${spec.label}不存在`)
  }
  return row
}

async function lockDraftHead(
  db: DbHandle,
  actor: Actor,
  spec: QuotationSideSpec,
  id: string,
  child: string,
): Promise<Record<string, unknown>> {
  const row = await lockHead(db, actor, spec, id)
  if (String(row.status).toLowerCase() !== 'draft') {
    let message = '仅草稿报价单可修改或删除'
    if (child === 'item') message = '仅草稿报价单可编辑条目'
    if (child === 'tier') message = '仅草稿报价单可编辑价格档'
    throw new ApiError('conflict', message)
  }
  return row
}

async function loadHeadRow(
  db: DbHandle,
  spec: QuotationSideSpec,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await sql<Record<string, unknown>>`
    SELECT q.id,q.quotation_no,q.quotation_date,q.valid_until,q.party_type,q.party_id,
      q.terms,q.remarks,q.status,q.audited_at,q.inserted_at,q.updated_at,q.company_id,
      q.currency_id,q.created_by_id,q.audited_by_id,c.name AS company_name,
      cur.iso_code AS currency_code,cur.name AS currency_name,
      creator.name AS created_by_name,auditor.name AS audited_by_name
    FROM ${ident(spec.headTable)} q
    JOIN bas_company c ON c.id=q.company_id
    JOIN bas_currency cur ON cur.id=q.currency_id
    LEFT JOIN sys_user creator ON creator.id=q.created_by_id
    LEFT JOIN sys_user auditor ON auditor.id=q.audited_by_id
    WHERE q.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadItemRow(
  db: DbHandle,
  spec: QuotationSideSpec,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await sql<Record<string, unknown>>`
    SELECT i.id,i.idx,i.pricing_mode,i.price,i.tax_rate,i.material_code,i.material_name,
      i.material_spec,i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,
      i.quotation_id,i.company_id,i.material_id,i.unit_id,
      (SELECT count(*) FROM ${ident(spec.tierTable)} t WHERE t.item_id=i.id)::bigint AS tier_count,
      q.quotation_date,q.valid_until,q.status AS quotation_status,q.party_type,q.party_id,
      cur.iso_code AS currency_code,q.quotation_no,c.name AS company_name,
      m.name AS material_live_name,u.name AS unit_live_name
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} q ON q.id=i.quotation_id
    JOIN bas_company c ON c.id=i.company_id
    JOIN bas_currency cur ON cur.id=q.currency_id
    JOIN inv_material m ON m.id=i.material_id
    JOIN bas_unit u ON u.id=i.unit_id
    WHERE i.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function loadTierRow(
  db: DbHandle,
  spec: QuotationSideSpec,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await sql<Record<string, unknown>>`
    SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
      c.name AS company_name
    FROM ${ident(spec.tierTable)} t
    JOIN bas_company c ON c.id=t.company_id
    WHERE t.id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

async function tierParent(
  db: DbHandle,
  spec: QuotationSideSpec,
  itemId: string,
): Promise<{ quotationId: string; companyId: string; mode: string }> {
  const rows = await sql<{
    quotation_id: string
    company_id: string
    pricing_mode: string
  }>`
    SELECT quotation_id, company_id, pricing_mode FROM ${ident(spec.itemTable)}
    WHERE id=${itemId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  if (!row) throw new ApiError('not_found', '报价条目不存在')
  return {
    quotationId: row.quotation_id,
    companyId: row.company_id,
    mode: row.pricing_mode.toLowerCase(),
  }
}

async function purgeTiers(
  db: DbHandle,
  actor: Actor,
  spec: QuotationSideSpec,
  itemId: string,
): Promise<void> {
  const rows = await sql<Record<string, unknown>>`
    SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
      c.name AS company_name
    FROM ${ident(spec.tierTable)} t
    JOIN bas_company c ON c.id=t.company_id
    WHERE t.item_id=${itemId}::uuid
    ORDER BY t.min_qty, t.id
  `.execute(db)
  await sql`DELETE FROM ${ident(spec.tierTable)} WHERE item_id=${itemId}::uuid`.execute(db)
  for (const row of rows.rows) {
    const item = mapTier(row)
    await writeAudit(db, actor, {
      resource: spec.tierAudit,
      recordId: item.id,
      recordLabel: item.minQty,
      companyId: item.companyId,
      actionType: 'destroy',
      actionName: 'purge',
      changes: auditDestroyed(tierSnap(item), TIER_AUDIT),
    })
  }
}

function mapHead(row: Record<string, unknown>): Quotation {
  const id = String(row.id)
  const companyId = String(row.company_id)
  const currencyId = String(row.currency_id)
  const createdById = row.created_by_id ? String(row.created_by_id) : null
  const auditedById = row.audited_by_id ? String(row.audited_by_id) : null
  return {
    id,
    quotationNo: String(row.quotation_no),
    quotationDate: asDate(row.quotation_date),
    validUntil: asDate(row.valid_until),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    terms: asOptionalString(row.terms),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    companyId,
    currencyId,
    createdById,
    auditedById,
    company: namedRef(companyId, String(row.company_name)),
    currency: codeNamedRef(
      currencyId,
      String(row.currency_code),
      String(row.currency_name),
    ),
    createdBy: createdById
      ? namedRef(createdById, String(row.created_by_name ?? ''))
      : null,
    auditedBy: auditedById
      ? namedRef(auditedById, String(row.audited_by_name ?? ''))
      : null,
  }
}

function mapItem(row: Record<string, unknown>): QuotationItem {
  const id = String(row.id)
  const companyId = String(row.company_id)
  const materialId = String(row.material_id)
  const unitId = String(row.unit_id)
  const quotationId = String(row.quotation_id)
  const price =
    row.price === null || row.price === undefined ? null : wireRequiredDecimal(String(row.price))
  return {
    id,
    idx: Number(row.idx),
    pricingMode: upperStatus(String(row.pricing_mode)),
    price,
    taxRate: wireRequiredDecimal(String(row.tax_rate)),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: String(row.unit_name),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    quotationId,
    companyId,
    materialId,
    unitId,
    tierCount: Number(row.tier_count ?? 0),
    quotationDate: asDate(row.quotation_date),
    validUntil: asDate(row.valid_until),
    quotationStatus: upperStatus(String(row.quotation_status)),
    partyType: upperStatus(String(row.party_type)),
    partyId: String(row.party_id),
    currencyCode: String(row.currency_code),
    quotation: { id: quotationId, quotationNo: String(row.quotation_no) },
    company: namedRef(companyId, String(row.company_name)),
    material: codeNamedRef(
      materialId,
      String(row.material_code),
      String(row.material_live_name ?? row.material_name),
    ),
    unit: namedRef(unitId, String(row.unit_live_name ?? row.unit_name)),
  }
}

function mapTier(row: Record<string, unknown>): QuotationTier {
  const companyId = String(row.company_id)
  return {
    id: String(row.id),
    minQty: wireRequiredDecimal(String(row.min_qty)),
    price: wireRequiredDecimal(String(row.price)),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    itemId: String(row.item_id),
    companyId,
    company: namedRef(companyId, String(row.company_name ?? '')),
  }
}

function headSnap(item: Quotation): Record<string, unknown> {
  return {
    quotation_no: item.quotationNo,
    quotation_date: item.quotationDate,
    valid_until: item.validUntil,
    party_type: lowerParty(item.partyType),
    party_id: item.partyId,
    terms: item.terms,
    remarks: item.remarks,
    status: item.status.toLowerCase(),
    audited_at: item.auditedAt,
    company_id: item.companyId,
    currency_id: item.currencyId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

function itemSnap(item: QuotationItem): Record<string, unknown> {
  return {
    idx: item.idx,
    pricing_mode: item.pricingMode.toLowerCase(),
    price: item.price,
    tax_rate: item.taxRate,
    material_code: item.materialCode,
    material_name: item.materialName,
    material_spec: item.materialSpec,
    customer_part_no: item.customerPartNo,
    unit_name: item.unitName,
    remarks: item.remarks,
    quotation_id: item.quotationId,
    company_id: item.companyId,
    material_id: item.materialId,
    unit_id: item.unitId,
  }
}

function tierSnap(item: QuotationTier): Record<string, unknown> {
  return {
    min_qty: item.minQty,
    price: item.price,
    item_id: item.itemId,
    company_id: item.companyId,
  }
}

function mapQuotationWrite(message: string, err: unknown): ApiError {
  return mapWriteError(err, message, [
    { code: '23505', constraint: 'quotation_unique_quotation_no', message: '报价单号已存在' },
    {
      code: '23505',
      constraint: 'quotation_item_unique_material_unit',
      message: '同一物料与单位在本报价单已有报价行',
    },
    {
      code: '23505',
      constraint: 'quotation_tier_unique_item_min_qty',
      message: '同一起订量档已存在',
    },
    { code: '23505', message: '报价数据已存在' },
    { code: '23503', message: '报价数据已被业务引用,不可删除' },
  ])
}

// silence unused import if any
void requireCompanyAccess
void wireDecimal
