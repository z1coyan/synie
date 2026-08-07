/**
 * 报价头/条目/价格档列表与写后 reload 共用投影（别名与 source 子查询必须逐字一致）。
 */
import { sql, type RawBuilder } from 'kysely'
import {
  asDate,
  codeNamedRef,
  ident,
  namedRef,
  upperStatus,
} from '../common.ts'
import type { QuotationSideSpec } from './spec.ts'

export const HEAD_ALIAS = 'quotation_heads'
export const ITEM_ALIAS = 'quotation_items'
export const TIER_ALIAS = 'quotation_tiers'

export const HEAD_EXTRA = sql`company_name,currency_code,currency_name,created_by_name,audited_by_name`
export const ITEM_EXTRA = sql`tier_count,quotation_date,valid_until,quotation_status,party_type,
  currency_code,currency_id,quotation_no,company_name,material_live_name,unit_live_name`
export const TIER_EXTRA = sql`company_name`

export function headSource(spec: QuotationSideSpec): RawBuilder<unknown> {
  return sql` FROM (
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
  ) quotation_heads`
}

export function itemSource(spec: QuotationSideSpec): RawBuilder<unknown> {
  return sql` FROM (
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
  ) quotation_items`
}

export function tierSource(spec: QuotationSideSpec): RawBuilder<unknown> {
  return sql` FROM (
    SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
      c.name AS company_name
    FROM ${ident(spec.tierTable)} t
    JOIN bas_company c ON c.id=t.company_id
  ) quotation_tiers`
}

export function headExtras(row: Record<string, unknown>): Record<string, unknown> {
  const companyId = String(row.company_id)
  const currencyId = String(row.currency_id)
  const createdById = row.created_by_id ? String(row.created_by_id) : null
  const auditedById = row.audited_by_id ? String(row.audited_by_id) : null
  return {
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

export function itemExtras(row: Record<string, unknown>): Record<string, unknown> {
  const quotationId = String(row.quotation_id)
  const companyId = String(row.company_id)
  const materialId = String(row.material_id)
  const unitId = String(row.unit_id)
  return {
    tierCount: Number(row.tier_count ?? 0),
    quotationDate: asDate(row.quotation_date),
    validUntil: asDate(row.valid_until),
    quotationStatus: upperStatus(String(row.quotation_status)),
    partyType: upperStatus(String(row.party_type)),
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

export function tierExtras(row: Record<string, unknown>): Record<string, unknown> {
  return {
    company: namedRef(String(row.company_id), String(row.company_name ?? '')),
  }
}
