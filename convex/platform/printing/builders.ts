import { Decimal, scaledInt64ToDecimal } from '@synie/shared'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { canAccessCompany } from '../../lib/companyScope'
import { synieError } from '../../lib/errors'
import { childrenFor, hydrateStored } from '../../domains/shared/records'
import { storeForResource, type ClosureStore } from '../../domains/shared/policies'
import {
  enumLabel,
  formatBool,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInt,
  formatText,
} from './format'
import type { BuiltDoc, PrintDoc } from './types'
import type { PrintableResource } from './catalog'

type QueryCtx = GenericQueryCtx<DataModel>
type Wire = Record<string, unknown>

const SALES_ORDER_STATUS_LABELS = { DRAFT: '草稿', AUDITED: '已审核', CLOSED: '已关闭', VOIDED: '已作废' }
const SALES_ORDER_TYPE_LABELS = { REGULAR: '常规订单', SAMPLE: '样品订单' }
const PARTY_TYPE_LABELS = { SUPPLIER: '供应商', CUSTOMER: '客户', COMPANY: '内部公司', EMPLOYEE: '员工' }
const UNIT_TYPE_LABELS = { LENGTH: '长度', AREA: '面积', WEIGHT: '重量', QUANTITY: '数量' }
const QUOTATION_PRICING_MODE_LABELS = { FIXED: '固定价', QTY_TIERED: '数量梯度' }
const WORK_ORDER_STATUS_LABELS = { IN_PROGRESS: '进行中', COMPLETED: '已完工', VOIDED: '已作废' }

function text(value: unknown): string { return value == null ? '' : String(value) }
function optionalText(value: unknown): string | null { return value == null ? null : String(value) }
function bool(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null }
function temporal(value: unknown): string | Date | null {
  return typeof value === 'number' ? new Date(value) : typeof value === 'string' ? value : null
}

async function closureRecord(ctx: QueryCtx, resource: string, id: unknown): Promise<Wire | null> {
  if (typeof id !== 'string') return null
  const table = storeForResource(resource)
  if (!table) return null
  const normalized = ctx.db.normalizeId(table, id)
  if (!normalized) return null
  const row = await ctx.db.get(normalized) as Doc<ClosureStore> | null
  return row?.resource === resource ? hydrateStored(row) : null
}

async function requiredClosure(ctx: QueryCtx, resource: string, id: string): Promise<Wire> {
  const row = await closureRecord(ctx, resource, id)
  if (!row) throw synieError('not_found', '部分单据不存在或无权查看')
  return row
}

async function formal<T extends keyof DataModel>(ctx: QueryCtx, table: T, id: unknown) {
  if (typeof id !== 'string') return null
  const normalized = ctx.db.normalizeId(table, id)
  return normalized ? ctx.db.get(normalized as never) : null
}

async function partyName(ctx: QueryCtx, partyType: unknown, partyId: unknown): Promise<string> {
  const table = partyType === 'COMPANY' ? 'companies'
    : partyType === 'CUSTOMER' ? 'customers'
      : partyType === 'SUPPLIER' ? 'suppliers'
        : partyType === 'EMPLOYEE' ? 'employees'
          : null
  if (!table) return ''
  const row = await formal(ctx, table, partyId) as { name?: string } | null
  return row?.name ?? ''
}

function sorted(rows: Wire[]): Wire[] {
  return [...rows].sort((left, right) =>
    Number(left.idx ?? left.seq ?? 0) - Number(right.idx ?? right.seq ?? 0) ||
    text(left.id).localeCompare(text(right.id)),
  )
}

async function assertHead(ctx: QueryCtx, actor: Actor, resource: string, id: string): Promise<Wire> {
  const head = await requiredClosure(ctx, resource, id)
  const companyId = text(head.companyId)
  if (!companyId || !canAccessCompany(actor, companyId)) {
    throw synieError('not_found', '部分单据不存在或无权查看')
  }
  return head
}

async function salesOrderDocs(ctx: QueryCtx, actor: Actor, ids: string[]): Promise<BuiltDoc[]> {
  const result: BuiltDoc[] = []
  for (const id of ids) {
    const head = await assertHead(ctx, actor, 'salOrders', id)
    const items = sorted(await childrenFor(ctx, 'salOrderItems', id))
    const [company, currency, creator, auditor, party] = await Promise.all([
      formal(ctx, 'companies', head.companyId),
      formal(ctx, 'currencies', head.currencyId),
      formal(ctx, 'appUsers', head.createdById),
      formal(ctx, 'appUsers', head.auditedById),
      partyName(ctx, head.partyType, head.partyId),
    ]) as [Doc<'companies'> | null, Doc<'currencies'> | null, Doc<'appUsers'> | null, Doc<'appUsers'> | null, string]
    const gross = items.reduce((sum, item) => sum.add(text(item.amount) || '0'), new Decimal(0))
    const baseGross = items.reduce((sum, item) => sum.add(text(item.baseAmount) || '0'), new Decimal(0))
    const doc: PrintDoc = {
      fields: {
        order_no: text(head.orderNo),
        order_date: formatDate(temporal(head.orderDate)),
        order_type: enumLabel(SALES_ORDER_TYPE_LABELS, optionalText(head.orderType)),
        party_type: enumLabel(PARTY_TYPE_LABELS, optionalText(head.partyType)),
        'party.name': party,
        exchange_rate: formatDecimal(text(head.exchangeRate)),
        terms: formatText(optionalText(head.terms)),
        remarks: formatText(optionalText(head.remarks)),
        status: enumLabel(SALES_ORDER_STATUS_LABELS, optionalText(head.status)),
        audited_at: formatDateTime(temporal(head.auditedAt)),
        gross_total: formatDecimal(text(head.grossTotal) || gross.toString()),
        base_gross_total: formatDecimal(text(head.baseGrossTotal) || baseGross.toString()),
        'company.code': company?.code ?? '',
        'company.name': company?.name ?? '',
        'company.short_name': company?.shortName ?? '',
        'currency.iso_code': currency?.isoCode ?? '',
        'currency.name': currency?.name ?? '',
        'currency.symbol': currency?.symbol ?? '',
        'currency.active': formatBool(currency?.active),
        'created_by.name': creator?.name ?? '',
        'created_by.username': creator?.username ?? '',
        'created_by.preferred_language': creator?.preferredLanguage ?? '',
        'audited_by.name': auditor?.name ?? '',
        'audited_by.username': auditor?.username ?? '',
        'audited_by.preferred_language': auditor?.preferredLanguage ?? '',
      },
      loops: { items: [] },
    }
    for (const item of items) {
      const [material, unit, quotation] = await Promise.all([
        formal(ctx, 'materials', item.materialId),
        formal(ctx, 'units', item.unitId),
        closureRecord(ctx, 'salQuotationItems', item.quotationItemId),
      ]) as [Doc<'materials'> | null, Doc<'units'> | null, Wire | null]
      const remaining = new Decimal(text(item.baseQty) || '0').sub(text(item.shippedQty) || '0')
      doc.loops.items!.push({
        idx: formatInt(item.idx as number | string | null),
        qty: formatDecimal(text(item.qty)), base_qty: formatDecimal(text(item.baseQty)),
        shipped_qty: formatDecimal(text(item.shippedQty)), remaining_base_qty: formatDecimal(remaining.toString()),
        price: formatDecimal(text(item.price)), amount: formatDecimal(text(item.amount)),
        base_price: formatDecimal(text(item.basePrice)), base_amount: formatDecimal(text(item.baseAmount)),
        tax_rate: formatDecimal(text(item.taxRate)), material_code: text(item.materialCode),
        material_name: text(item.materialName), material_spec: formatText(optionalText(item.materialSpec)),
        customer_part_no: formatText(optionalText(item.customerPartNo)), unit_name: text(item.unitName),
        remarks: formatText(optionalText(item.remarks)), order_date: formatDate(temporal(head.orderDate)),
        order_status: enumLabel(SALES_ORDER_STATUS_LABELS, optionalText(head.status)),
        party_type: enumLabel(PARTY_TYPE_LABELS, optionalText(head.partyType)), party_id: text(head.partyId),
        currency_code: currency?.isoCode ?? text(item.currencyCode),
        'company.code': company?.code ?? '', 'company.name': company?.name ?? '',
        'company.short_name': company?.shortName ?? '',
        'material.code': material?.code ?? '', 'material.name': material?.name ?? '',
        'material.spec': material?.spec ?? '', 'material.customer_part_no': material?.customerPartNo ?? '',
        'material.active': formatBool(material?.active), 'material.is_customer_material': formatBool(material?.isCustomerMaterial),
        'unit.name': unit?.name ?? '', 'unit.symbol': unit?.symbol ?? '',
        'unit.ratio': unit ? formatDecimal(scaledInt64ToDecimal(unit.ratioScaled, 6)) : '',
        'unit.is_base': formatBool(unit?.isBase), 'unit.unit_type': enumLabel(UNIT_TYPE_LABELS, unit?.unitType),
        'order.order_no': text(head.orderNo), 'order.order_date': formatDate(temporal(head.orderDate)),
        'order.order_type': enumLabel(SALES_ORDER_TYPE_LABELS, optionalText(head.orderType)),
        'order.party_type': enumLabel(PARTY_TYPE_LABELS, optionalText(head.partyType)),
        'order.status': enumLabel(SALES_ORDER_STATUS_LABELS, optionalText(head.status)),
        'order.terms': formatText(optionalText(head.terms)), 'order.remarks': formatText(optionalText(head.remarks)),
        'order.exchange_rate': formatDecimal(text(head.exchangeRate)), 'order.audited_at': formatDateTime(temporal(head.auditedAt)),
        'quotation_item.idx': formatInt(quotation?.idx as number | string | null),
        'quotation_item.pricing_mode': enumLabel(QUOTATION_PRICING_MODE_LABELS, optionalText(quotation?.pricingMode)),
        'quotation_item.price': formatDecimal(text(quotation?.price)),
        'quotation_item.tax_rate': formatDecimal(text(quotation?.taxRate)),
        'quotation_item.material_code': text(quotation?.materialCode),
        'quotation_item.material_name': text(quotation?.materialName),
        'quotation_item.material_spec': text(quotation?.materialSpec),
        'quotation_item.customer_part_no': text(quotation?.customerPartNo),
        'quotation_item.unit_name': text(quotation?.unitName),
        'quotation_item.remarks': text(quotation?.remarks),
      })
    }
    result.push({ sheetName: text(head.orderNo), doc })
  }
  return result
}

async function workOrderDocs(ctx: QueryCtx, actor: Actor, ids: string[]): Promise<BuiltDoc[]> {
  const result: BuiltDoc[] = []
  for (const id of ids) {
    const head = await assertHead(ctx, actor, 'mfgWorkOrders', id)
    const [components, routes, byproducts, company, demand, bom, creator] = await Promise.all([
      childrenFor(ctx, 'mfgWorkOrderComponents', id).then(sorted),
      childrenFor(ctx, 'mfgWorkOrderRoutes', id).then(sorted),
      childrenFor(ctx, 'mfgWorkOrderByproducts', id).then(sorted),
      formal(ctx, 'companies', head.companyId),
      closureRecord(ctx, 'mfgDemands', head.demandId),
      closureRecord(ctx, 'mfgBoms', head.bomId),
      formal(ctx, 'appUsers', head.createdById),
    ]) as [Wire[], Wire[], Wire[], Doc<'companies'> | null, Wire | null, Wire | null, Doc<'appUsers'> | null]
    const lines = async (rows: Wire[]) => Promise.all(rows.map(async (row) => {
      const [material, unit] = await Promise.all([
        formal(ctx, 'materials', row.materialId), formal(ctx, 'units', row.unitId),
      ]) as [Doc<'materials'> | null, Doc<'units'> | null]
      return { row, material, unit }
    }))
    const [componentRefs, byproductRefs] = await Promise.all([lines(components), lines(byproducts)])
    const routeRefs = await Promise.all(routes.map(async (row) => ({
      row,
      operation: await closureRecord(ctx, 'mfgOperations', row.operationId),
    })))
    const doc: PrintDoc = {
      fields: {
        work_order_no: text(head.workOrderNo), qty: formatDecimal(text(head.qty)),
        base_qty: formatDecimal(text(head.baseQty)), received_base_qty: formatDecimal(text(head.receivedBaseQty)),
        remaining_base_qty: formatDecimal(text(head.remainingBaseQty)), need_date: formatDate(temporal(head.needDate)),
        material_code: text(head.materialCode), material_name: text(head.materialName),
        material_spec: formatText(optionalText(head.materialSpec)), unit_name: text(head.unitName),
        status: enumLabel(WORK_ORDER_STATUS_LABELS, optionalText(head.status)),
        'company.code': company?.code ?? '', 'company.name': company?.name ?? '',
        'company.short_name': company?.shortName ?? '', 'demand.demand_no': text(demand?.demandNo),
        'bom.code': text(bom?.code), 'bom.plan_name': text(bom?.planName),
        'created_by.name': creator?.name ?? '', inserted_at: formatDateTime(temporal(head.insertedAt)),
        updated_at: formatDateTime(temporal(head.updatedAt)),
      },
      loops: {
        components: componentRefs.map(({ row, material, unit }) => ({
          quantity: formatDecimal(text(row.quantity)), loss_rate: formatDecimal(text(row.lossRate)),
          note: text(row.note), idx: formatInt(row.idx as number | string | null),
          'material.code': material?.code ?? '', 'material.name': material?.name ?? '',
          'material.spec': material?.spec ?? '', 'unit.name': unit?.name ?? '', 'unit.symbol': unit?.symbol ?? '',
        })),
        routes: routeRefs.map(({ row, operation }) => ({
          seq: formatInt(row.seq as number | string | null), requirement: text(row.requirement),
          is_outsourced: formatBool(bool(row.isOutsourced)), 'operation.code': text(operation?.code),
          'operation.name': text(operation?.name),
        })),
        byproducts: byproductRefs.map(({ row, material, unit }) => ({
          quantity: formatDecimal(text(row.quantity)), note: text(row.note),
          idx: formatInt(row.idx as number | string | null), 'material.code': material?.code ?? '',
          'material.name': material?.name ?? '', 'material.spec': material?.spec ?? '',
          'unit.name': unit?.name ?? '', 'unit.symbol': unit?.symbol ?? '',
        })),
      },
    }
    result.push({ sheetName: text(head.workOrderNo), doc })
  }
  return result
}

export function printResourceLabel(resource: PrintableResource): string {
  return resource === 'sales.order' ? '销售订单' : '生产工单'
}

export function buildDocuments(
  ctx: QueryCtx,
  actor: Actor,
  resource: PrintableResource,
  ids: string[],
): Promise<BuiltDoc[]> {
  return resource === 'sales.order'
    ? salesOrderDocs(ctx, actor, ids)
    : workOrderDocs(ctx, actor, ids)
}

export async function selectedDocumentCompanyIds(
  ctx: QueryCtx,
  actor: Actor,
  resource: PrintableResource,
  ids: string[],
): Promise<string[]> {
  const headResource = resource === 'sales.order' ? 'salOrders' : 'mfgWorkOrders'
  const result = new Set<string>()
  for (const id of ids) {
    const head = await assertHead(ctx, actor, headResource, id)
    result.add(text(head.companyId))
  }
  return [...result].sort()
}
