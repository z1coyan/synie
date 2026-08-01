import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { canAccessCompany } from '../../lib/companyScope'
import { decimalToScaledInt64 } from '../../lib/decimal'
import { synieError } from '../../lib/errors'
import { paginationOptions, requireSearchTerm } from '../../lib/pagination'
import { catalogDocument, decimalScaleForField, storeForResource } from './policies'

type ReadCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
type WireRecord = Record<string, unknown>

export type CandidateProjectionRow = {
  profile: string
  recordId: string
  key: string
  sortValue: string
  searchText: string
}

export type ResolvedDomainCandidateProfile = {
  profile: string
  keys: string[]
}

type CandidateCursor =
  | { v: 1; kind: 'sort'; fingerprint: string; last: string }
  | { v: 1; kind: 'search'; fingerprint: string; keyIndex: number; cursor: string | null }

type CandidatePage = {
  page: Array<Doc<'domainCandidateRows'>>
  continueCursor: string
  isDone: boolean
}

export const DOMAIN_CANDIDATE_RESOURCES = new Set([
  'accBankAccounts',
  'accBankImportTemplates',
  'accBillHoldings',
  'accVatInvoices',
  'salReconciliations',
  'purReconciliations',
  'salOrderItems',
  'purOrderItems',
  'purOrderItemMaterials',
  'salQuotationItems',
  'purQuotationItems',
  'salDeliveryItems',
  'purReceiptItems',
  'purOutsourcedReceiptItems',
  'mfgBoms',
  'mfgDemandItems',
  'mfgWorkOrders',
])

const DATE_MS = 86_400_000
const DATE_ORIGIN = Date.parse('0001-01-01T00:00:00.000Z')
const DATE_TREE_LEAVES = 1 << 22

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredText(args: WireRecord, field: string): string {
  const value = text(args[field])
  if (!value) throw synieError('validation', `${field} 必须是非空字符串`)
  return value
}

function requiredBoolean(args: WireRecord, field: string): boolean {
  if (typeof args[field] !== 'boolean') throw synieError('validation', `${field} 必须是布尔值`)
  return args[field]
}

function company(actor: Actor, args: WireRecord): string {
  const companyId = requiredText(args, 'companyId')
  if (!canAccessCompany(actor, companyId)) throw synieError('not_found', '公司不存在')
  return companyId
}

function exactArgs(args: WireRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set(['candidateProfile', ...required, ...optional])
  const extra: string[] = []
  for (const field of Object.keys(args)) if (!allowed.has(field)) extra.push(field)
  if (extra.length) throw synieError('validation', `候选 profile 不接受参数: ${extra.join(',')}`)
  const missing: string[] = []
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(args, field)) missing.push(field)
  if (missing.length) throw synieError('validation', `候选 profile 缺少参数: ${missing.join(',')}`)
}

/** Canonical, type-aware equality key. IDs remain case-sensitive. */
function candidateKey(parts: ReadonlyArray<readonly [string, string | boolean]>): string {
  return JSON.stringify(parts.map(([field, value]) => [
    field,
    typeof value === 'boolean' ? `b:${value ? '1' : '0'}` : `s:${value}`,
  ]))
}

const ALL_COMPANIES_CANDIDATE_KEY = candidateKey([['scope', 'allCompanies']])

function canonicalDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw synieError('validation', `${field} 必须是 YYYY-MM-DD 日期`)
  }
  const instant = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) {
    throw synieError('validation', `${field} 不是有效日期`)
  }
  return value
}

function dateIndex(value: string): number {
  const result = Math.round((Date.parse(`${value}T00:00:00.000Z`) - DATE_ORIGIN) / DATE_MS)
  if (!Number.isSafeInteger(result) || result < 0 || result >= DATE_TREE_LEAVES) {
    throw synieError('validation', '日期超出候选索引范围')
  }
  return result
}

/** Canonical segment-tree cover: an interval and a point share exactly one node. */
function intervalSegments(start: string, end: string): number[] {
  let left = DATE_TREE_LEAVES + dateIndex(start)
  let right = DATE_TREE_LEAVES + dateIndex(end)
  if (left > right) return []
  const result: number[] = []
  while (left <= right) {
    if ((left & 1) === 1) result.push(left++)
    if ((right & 1) === 0) result.push(right--)
    left >>= 1
    right >>= 1
  }
  return result
}

function pointSegments(value: string): number[] {
  const result: number[] = []
  let node = DATE_TREE_LEAVES + dateIndex(value)
  while (node >= 1) {
    result.push(node)
    node >>= 1
  }
  return result
}

function integerKey(value: number | bigint): string {
  const numeric = typeof value === 'bigint' ? value : BigInt(value)
  const shifted = numeric + (1n << 127n)
  if (shifted < 0n || shifted >= (1n << 128n)) throw synieError('internal', '候选排序整数超出范围')
  return shifted.toString().padStart(39, '0')
}

function valueKey(resource: string, fieldName: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '0:'
  const field = catalogDocument(resource).fields.find((candidate) => candidate.name === fieldName)
  if (!field) throw synieError('internal', `${resource}.${fieldName} 缺少 Catalog 字段`)
  if (field.scalarType === 'decimal') {
    return `1:d:${integerKey(decimalToScaledInt64(String(value), decimalScaleForField(field)))}`
  }
  if (field.scalarType === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw synieError('internal', `${resource}.${fieldName} 排序值不是安全整数`)
    }
    return `1:i:${integerKey(value)}`
  }
  if (field.scalarType === 'datetime') {
    const instant = typeof value === 'number' ? value : Date.parse(String(value))
    if (!Number.isFinite(instant) || !Number.isSafeInteger(instant)) {
      throw synieError('internal', `${resource}.${fieldName} 排序时间损坏`)
    }
    return `1:t:${integerKey(instant)}`
  }
  if (field.scalarType === 'boolean') return value === true ? '1:b:1' : '1:b:0'
  return `1:s:${String(value).normalize('NFKC').toLocaleLowerCase('en-US')}`
}

function candidateSearchText(resource: string, wire: WireRecord): string {
  const document = catalogDocument(resource)
  const fields = new Set([document.lookup.labelField, ...document.lookup.searchFields])
  const values: string[] = []
  for (const field of fields) {
    const value = wire[field]
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const normalized = String(value).trim()
    if (normalized) values.push(normalized)
  }
  return values.join(' ').normalize('NFKC').toLocaleLowerCase('en-US')
}

function positiveDecimal(resource: string, fieldName: string, value: unknown): boolean {
  const field = catalogDocument(resource).fields.find((candidate) => candidate.name === fieldName)
  if (!field || field.scalarType !== 'decimal' || typeof value !== 'string') return false
  try {
    return decimalToScaledInt64(value, decimalScaleForField(field)) > 0n
  } catch {
    return false
  }
}

function projection(
  resource: string,
  recordId: string,
  profile: string,
  key: string,
  sortField: string,
  wire: WireRecord,
): CandidateProjectionRow {
  return {
    profile,
    recordId,
    key,
    sortValue: `${valueKey(resource, sortField, wire[sortField])}:${recordId}`,
    searchText: candidateSearchText(resource, wire),
  }
}

async function relatedWire(ctx: ReadCtx, resource: string, id: string): Promise<WireRecord | null> {
  const table = storeForResource(resource)
  if (!table) return null
  const normalized = ctx.db.normalizeId(table, id)
  if (!normalized) return null
  const row = await ctx.db.get(normalized as never) as {
    resource: string
    companyId: string | null
    parentId: string | null
    status: string | null
    data: unknown
  } | null
  if (!row || row.resource !== resource || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return null
  return {
    ...(row.data as WireRecord),
    companyId: row.companyId,
    parentId: row.parentId,
    status: row.status,
  }
}

async function expenseInvoiceAvailable(ctx: ReadCtx, invoiceId: string): Promise<boolean> {
  const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
    q.eq('targetResource', 'accVatInvoices').eq('targetRecordId', invoiceId),
  ).collect()
  for (const reference of references) {
    if (reference.sourceResource !== 'accExpenseReportItems' || reference.field !== 'invoiceId') continue
    const item = await relatedWire(ctx, 'accExpenseReportItems', reference.sourceRecordId)
    if (!item) return false
    const reportId = text(item?.reportId) ?? text(item?.parentId)
    if (!reportId) return false
    const report = await relatedWire(ctx, 'accExpenseReports', reportId)
    if (!report || report.status !== 'VOIDED') return false
  }
  return true
}

async function salesLineComesFromRegularOrder(ctx: ReadCtx, wire: WireRecord): Promise<boolean> {
  const itemId = text(wire.orderItemId)
  if (!itemId) return false
  const item = await relatedWire(ctx, 'salOrderItems', itemId)
  const orderId = text(item?.orderId) ?? text(item?.parentId)
  if (!orderId) return false
  const order = await relatedWire(ctx, 'salOrders', orderId)
  return order?.orderType === 'REGULAR'
}

/** Builds every named candidate row owned by one closure record. */
export async function candidateProjectionRows(
  ctx: ReadCtx,
  resource: string,
  recordId: string,
  wire: WireRecord,
): Promise<CandidateProjectionRow[]> {
  if (!DOMAIN_CANDIDATE_RESOURCES.has(resource)) return []
  const rows: CandidateProjectionRow[] = []

  if (resource === 'accBankAccounts') {
    const companyId = text(wire.companyId)
    if (companyId && wire.active === true) rows.push(projection(resource, recordId, 'bankAccountActive', candidateKey([
      ['companyId', companyId], ['active', true],
    ]), 'alias', wire))
    return rows
  }
  if (resource === 'accBankImportTemplates') {
    const bankAccountId = text(wire.bankAccountId)
    if (bankAccountId) rows.push(projection(resource, recordId, 'bankImportTemplateByAccount', candidateKey([
      ['bankAccountId', bankAccountId],
    ]), 'name', wire))
    return rows
  }
  if (resource === 'accBillHoldings') {
    const companyId = text(wire.companyId)
    const bankAccountId = text(wire.bankAccountId)
    if (companyId && bankAccountId) rows.push(projection(resource, recordId, 'billHoldingByAccount', candidateKey([
      ['companyId', companyId], ['bankAccountId', bankAccountId],
    ]), 'dueDate', wire))
    return rows
  }
  if (resource === 'accVatInvoices') {
    const companyId = text(wire.companyId)
    const employeeId = text(wire.partyId)
    if (companyId && employeeId && wire.direction === 'INBOUND' && wire.partyType === 'EMPLOYEE' &&
        wire.status === 'AUDITED' && await expenseInvoiceAvailable(ctx, recordId)) {
      rows.push(projection(resource, recordId, 'expenseInvoice', candidateKey([
        ['companyId', companyId], ['employeeId', employeeId],
      ]), 'docNo', wire))
    }
    return rows
  }
  if (resource === 'salReconciliations' || resource === 'purReconciliations') {
    const companyId = text(wire.companyId)
    const partyType = text(wire.partyType)
    const partyId = text(wire.partyId)
    if (companyId && partyType && partyId && wire.status === 'CONFIRMED' && wire.reconciliationType === 'REGULAR') {
      rows.push(projection(resource, recordId, 'invoiceReconciliation', candidateKey([
        ['companyId', companyId], ['partyType', partyType], ['partyId', partyId],
      ]), 'reconciliationNo', wire))
    }
    return rows
  }
  if (resource === 'salOrderItems' || resource === 'purOrderItems') {
    const companyId = text(wire.companyId)
    const partyType = text(wire.partyType)
    const partyId = text(wire.partyId)
    const outsourced = resource === 'purOrderItems' ? wire.orderIsOutsourced : false
    if (companyId && partyType && partyId && typeof outsourced === 'boolean' && wire.orderStatus === 'AUDITED' &&
        positiveDecimal(resource, 'remainingBaseQty', wire.remainingBaseQty)) {
      rows.push(projection(resource, recordId, 'orderItemFulfillment', candidateKey([
        ['companyId', companyId], ['partyType', partyType], ['partyId', partyId], ['orderIsOutsourced', outsourced],
      ]), 'orderDate', wire))
    }
    return rows
  }
  if (resource === 'purOrderItemMaterials') {
    let effective = wire
    const orderItemId = text(wire.orderItemId)
    if (orderItemId) {
      const orderItem = await relatedWire(ctx, 'purOrderItems', orderItemId)
      const orderId = text(orderItem?.orderId) ?? text(orderItem?.parentId)
      const order = orderId ? await relatedWire(ctx, 'purOrders', orderId) : null
      if (order) effective = {
        ...wire,
        companyId: wire.companyId ?? order.companyId,
        partyType: wire.partyType ?? order.partyType,
        partyId: wire.partyId ?? order.partyId,
        orderNo: wire.orderNo ?? order.orderNo,
        orderStatus: order.status,
        orderIsOutsourced: order.isOutsourced,
      }
    }
    const companyId = text(effective.companyId)
    const partyType = text(effective.partyType)
    const partyId = text(effective.partyId)
    if (companyId && partyType && partyId && effective.orderStatus === 'AUDITED' && effective.orderIsOutsourced === true &&
        positiveDecimal(resource, 'remainingIssueQty', effective.remainingIssueQty)) {
      rows.push(projection(resource, recordId, 'outsourcedMaterialIssue', candidateKey([
        ['companyId', companyId], ['partyType', partyType], ['partyId', partyId],
      ]), 'orderNo', effective))
    }
    return rows
  }
  if (resource === 'salQuotationItems' || resource === 'purQuotationItems') {
    let effective = wire
    if (!text(wire.quotationDate) || !text(wire.validUntil) || !text(wire.currencyId) || !text(wire.quotationStatus)) {
      const quotationId = text(wire.quotationId) ?? text(wire.parentId)
      const headResource = resource === 'salQuotationItems' ? 'salQuotations' : 'purQuotations'
      const head = quotationId ? await relatedWire(ctx, headResource, quotationId) : null
      if (head) effective = {
        ...wire,
        companyId: wire.companyId ?? head.companyId,
        partyType: wire.partyType ?? head.partyType,
        partyId: wire.partyId ?? head.partyId,
        currencyId: head.currencyId,
        quotationDate: head.quotationDate,
        validUntil: head.validUntil,
        quotationStatus: head.status,
      }
    }
    const companyId = text(effective.companyId)
    const partyType = text(effective.partyType)
    const partyId = text(effective.partyId)
    const currencyId = text(effective.currencyId)
    if (!companyId || !partyType || !partyId || !currencyId || effective.quotationStatus !== 'AUDITED') return rows
    const start = canonicalDate(effective.quotationDate, 'quotationDate')
    const end = canonicalDate(effective.validUntil, 'validUntil')
    for (const segment of intervalSegments(start, end)) rows.push(projection(
      resource,
      recordId,
      'quotationItemValid',
      candidateKey([
        ['companyId', companyId], ['partyType', partyType], ['partyId', partyId],
        ['currencyId', currencyId], ['segment', String(segment)],
      ]),
      'materialCode',
      effective,
    ))
    return rows
  }
  if (resource === 'salDeliveryItems' || resource === 'purReceiptItems' || resource === 'purOutsourcedReceiptItems') {
    const companyId = text(wire.companyId)
    const partyType = text(wire.partyType)
    const partyId = text(wire.partyId)
    const statusField = resource === 'salDeliveryItems' ? 'deliveryStatus' : 'receiptStatus'
    const sortField = resource === 'salDeliveryItems' ? 'deliveryDate' : 'receiptDate'
    if (!companyId || !partyType || !partyId || wire[statusField] !== 'AUDITED' ||
        !positiveDecimal(resource, 'remainingReconcilableQty', wire.remainingReconcilableQty)) return rows
    const currency = text(wire.orderCurrencyCode)
    const add = (kind: string) => {
      const common: Array<readonly [string, string | boolean]> = [
        ['companyId', companyId], ['partyType', partyType], ['partyId', partyId], ['reconciliationType', kind],
      ]
      rows.push(projection(resource, recordId, 'reconciliationLine', candidateKey(common), sortField, wire))
      if (currency) rows.push(projection(resource, recordId, 'reconciliationLine', candidateKey([
        ...common, ['orderCurrencyCode', currency],
      ]), sortField, wire))
    }
    add('GIFT_SAMPLE')
    const regular = positiveDecimal(resource, 'orderPrice', wire.orderPrice) &&
      (resource !== 'salDeliveryItems' || await salesLineComesFromRegularOrder(ctx, wire))
    if (regular) add('REGULAR')
    return rows
  }
  if (resource === 'mfgBoms') {
    const materialId = text(wire.materialId)
    const status = text(wire.status)
    if (materialId) {
      rows.push(projection(resource, recordId, 'bomByMaterial', candidateKey([['materialId', materialId]]), 'code', wire))
      if (status) rows.push(projection(resource, recordId, 'bomByMaterial', candidateKey([
        ['materialId', materialId], ['status', status],
      ]), 'code', wire))
    }
    return rows
  }
  if (resource === 'mfgDemandItems') {
    const companyId = text(wire.companyId)
    const demandId = text(wire.demandId) ?? text(wire.parentId)
    const demand = demandId ? await relatedWire(ctx, 'mfgDemands', demandId) : null
    if (companyId && demand?.status === 'CONFIRMED' && wire.status !== 'COMPLETED' &&
        positiveDecimal(resource, 'remainingArrangeableQty', wire.remainingArrangeableQty)) {
      rows.push(projection(resource, recordId, 'demandItemWorkOrder', candidateKey([['companyId', companyId]]), 'needDate', wire))
      rows.push(projection(resource, recordId, 'demandItemWorkOrder', ALL_COMPANIES_CANDIDATE_KEY, 'needDate', wire))
    }
    return rows
  }
  if (resource === 'mfgWorkOrders') {
    const companyId = text(wire.companyId)
    if (companyId && wire.status === 'IN_PROGRESS' && positiveDecimal(resource, 'remainingBaseQty', wire.remainingBaseQty)) {
      rows.push(projection(resource, recordId, 'workOrderOutput', candidateKey([['companyId', companyId]]), 'needDate', wire))
    }
  }
  return rows
}

/** Strictly resolves the public flat args into one or more exact index keys. */
export function resolveDomainCandidateProfile(
  actor: Actor,
  resource: string,
  args: WireRecord,
): ResolvedDomainCandidateProfile {
  const profile = requiredText(args, 'candidateProfile')
  const one = (parts: ReadonlyArray<readonly [string, string | boolean]>): ResolvedDomainCandidateProfile => ({
    profile,
    keys: [candidateKey(parts)],
  })

  if (resource === 'accBankAccounts' && profile === 'bankAccountActive') {
    exactArgs(args, ['companyId', 'active'])
    const companyId = company(actor, args)
    const active = requiredBoolean(args, 'active')
    if (!active) throw synieError('validation', 'bankAccountActive 只接受启用账户')
    return one([['companyId', companyId], ['active', active]])
  }
  if (resource === 'accBankImportTemplates' && profile === 'bankImportTemplateByAccount') {
    exactArgs(args, ['bankAccountId'])
    return one([['bankAccountId', requiredText(args, 'bankAccountId')]])
  }
  if (resource === 'accBillHoldings' && profile === 'billHoldingByAccount') {
    exactArgs(args, ['companyId', 'bankAccountId'])
    return one([['companyId', company(actor, args)], ['bankAccountId', requiredText(args, 'bankAccountId')]])
  }
  if (resource === 'accVatInvoices' && profile === 'expenseInvoice') {
    exactArgs(args, ['companyId', 'employeeId'])
    return one([['companyId', company(actor, args)], ['employeeId', requiredText(args, 'employeeId')]])
  }
  if ((resource === 'salReconciliations' || resource === 'purReconciliations') && profile === 'invoiceReconciliation') {
    exactArgs(args, ['companyId', 'partyType', 'partyId'])
    return one([
      ['companyId', company(actor, args)], ['partyType', requiredText(args, 'partyType')], ['partyId', requiredText(args, 'partyId')],
    ])
  }
  if ((resource === 'salOrderItems' || resource === 'purOrderItems') && profile === 'orderItemFulfillment') {
    exactArgs(args, ['companyId', 'partyType', 'partyId', 'orderIsOutsourced'])
    const outsourced = requiredBoolean(args, 'orderIsOutsourced')
    if (resource === 'salOrderItems' && outsourced) throw synieError('validation', '销售订单条目不能是委外订单')
    return one([
      ['companyId', company(actor, args)], ['partyType', requiredText(args, 'partyType')],
      ['partyId', requiredText(args, 'partyId')], ['orderIsOutsourced', outsourced],
    ])
  }
  if (resource === 'purOrderItemMaterials' && profile === 'outsourcedMaterialIssue') {
    exactArgs(args, ['companyId', 'partyType', 'partyId'])
    return one([
      ['companyId', company(actor, args)], ['partyType', requiredText(args, 'partyType')], ['partyId', requiredText(args, 'partyId')],
    ])
  }
  if ((resource === 'salQuotationItems' || resource === 'purQuotationItems') && profile === 'quotationItemValid') {
    exactArgs(args, ['companyId', 'partyType', 'partyId', 'currencyId', 'orderDate'])
    const common: Array<readonly [string, string | boolean]> = [
      ['companyId', company(actor, args)], ['partyType', requiredText(args, 'partyType')],
      ['partyId', requiredText(args, 'partyId')], ['currencyId', requiredText(args, 'currencyId')],
    ]
    const orderDate = canonicalDate(args.orderDate, 'orderDate')
    return { profile, keys: pointSegments(orderDate).map((segment) => candidateKey([...common, ['segment', String(segment)]])) }
  }
  if (
    (resource === 'salDeliveryItems' || resource === 'purReceiptItems' || resource === 'purOutsourcedReceiptItems') &&
    profile === 'reconciliationLine'
  ) {
    exactArgs(args, ['companyId', 'partyType', 'partyId', 'reconciliationType'], ['orderCurrencyCode'])
    const kind = requiredText(args, 'reconciliationType')
    if (kind !== 'REGULAR' && kind !== 'GIFT_SAMPLE') throw synieError('validation', 'reconciliationType 不合法')
    const parts: Array<readonly [string, string | boolean]> = [
      ['companyId', company(actor, args)], ['partyType', requiredText(args, 'partyType')],
      ['partyId', requiredText(args, 'partyId')], ['reconciliationType', kind],
    ]
    if (Object.prototype.hasOwnProperty.call(args, 'orderCurrencyCode')) {
      parts.push(['orderCurrencyCode', requiredText(args, 'orderCurrencyCode')])
    }
    return one(parts)
  }
  if (resource === 'mfgBoms' && profile === 'bomByMaterial') {
    exactArgs(args, ['materialId'], ['status'])
    const parts: Array<readonly [string, string | boolean]> = [['materialId', requiredText(args, 'materialId')]]
    if (Object.prototype.hasOwnProperty.call(args, 'status')) {
      const status = requiredText(args, 'status')
      if (!['DRAFT', 'ACTIVE', 'INACTIVE'].includes(status)) throw synieError('validation', 'BOM 状态不合法')
      parts.push(['status', status])
    }
    return one(parts)
  }
  if (resource === 'mfgDemandItems' && profile === 'demandItemWorkOrder') {
    exactArgs(args, [], ['companyId'])
    if (Object.prototype.hasOwnProperty.call(args, 'companyId')) {
      return one([['companyId', company(actor, args)]])
    }
    if (actor.superAdmin || actor.allCompanies) {
      return { profile, keys: [ALL_COMPANIES_CANDIDATE_KEY] }
    }
    return {
      profile,
      keys: [...new Set(actor.companyIds)]
        .sort()
        .map((companyId) => candidateKey([['companyId', companyId]])),
    }
  }
  if (resource === 'mfgWorkOrders' && profile === 'workOrderOutput') {
    exactArgs(args, ['companyId'])
    return one([['companyId', company(actor, args)]])
  }
  throw synieError('validation', `${resource} 未声明候选 profile ${profile}`)
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function encodeCursor(value: CandidateCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let encoded = ''
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0
    const second = bytes[offset + 1] ?? 0
    const third = bytes[offset + 2] ?? 0
    const packed = (first << 16) | (second << 8) | third
    encoded += BASE64URL[(packed >> 18) & 63]
    encoded += BASE64URL[(packed >> 12) & 63]
    if (offset + 1 < bytes.length) encoded += BASE64URL[(packed >> 6) & 63]
    if (offset + 2 < bytes.length) encoded += BASE64URL[packed & 63]
  }
  return `candidate:${encoded}`
}

function decodeCursor(value: string | null | undefined): CandidateCursor | null {
  if (!value) return null
  if (!value.startsWith('candidate:')) throw synieError('validation', '候选分页游标不合法')
  const encoded = value.slice('candidate:'.length)
  const bytes: number[] = []
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const chunk = encoded.slice(offset, offset + 4)
    const values: number[] = []
    for (const character of chunk) {
      const index = BASE64URL.indexOf(character)
      if (index < 0) throw synieError('validation', '候选分页游标不合法')
      values.push(index)
    }
    if (values.length < 2) throw synieError('validation', '候选分页游标不合法')
    const packed = (values[0]! << 18) | (values[1]! << 12) | ((values[2] ?? 0) << 6) | (values[3] ?? 0)
    bytes.push((packed >> 16) & 255)
    if (values.length >= 3) bytes.push((packed >> 8) & 255)
    if (values.length >= 4) bytes.push(packed & 255)
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as Partial<CandidateCursor>
    if (parsed.v !== 1 || (parsed.kind !== 'sort' && parsed.kind !== 'search') || typeof parsed.fingerprint !== 'string') {
      throw new Error('shape')
    }
    if (parsed.kind === 'sort' && typeof parsed.last === 'string') return parsed as CandidateCursor
    if (parsed.kind === 'search' && Number.isSafeInteger(parsed.keyIndex) && (parsed.cursor === null || typeof parsed.cursor === 'string')) {
      return parsed as CandidateCursor
    }
  } catch {
    // Converted to the stable public validation error below.
  }
  throw synieError('validation', '候选分页游标不合法')
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  const bytes = new TextEncoder().encode(value)
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

async function authorizeImpliedScope(
  ctx: ReadCtx,
  actor: Actor,
  resource: string,
  profile: string,
  args: WireRecord,
): Promise<void> {
  if (resource === 'accBankImportTemplates' && profile === 'bankImportTemplateByAccount') {
    const account = await relatedWire(ctx, 'accBankAccounts', requiredText(args, 'bankAccountId'))
    const companyId = text(account?.companyId)
    if (!companyId || !canAccessCompany(actor, companyId)) throw synieError('not_found', '银行账户不存在')
  }
}

/**
 * Reads a named candidate pool exclusively through exact index/search keys.
 * Multi-key quotation intervals merge by the server-owned fixed sort.
 */
export async function paginateDomainCandidateRows(
  ctx: ReadCtx,
  actor: Actor,
  resource: string,
  input: { numItems: number; cursor?: string | null; search?: string; args: WireRecord },
): Promise<CandidatePage> {
  paginationOptions(input)
  const resolved = resolveDomainCandidateProfile(actor, resource, input.args)
  await authorizeImpliedScope(ctx, actor, resource, resolved.profile, input.args)
  const search = input.search === undefined ? null : requireSearchTerm(input.search)
  const expectedFingerprint = fingerprint(JSON.stringify([resource, resolved.profile, resolved.keys, search]))
  const decoded = decodeCursor(input.cursor)
  if (decoded && decoded.fingerprint !== expectedFingerprint) throw synieError('validation', '候选分页游标与查询不匹配')

  if (search !== null) {
    if (decoded?.kind === 'sort') throw synieError('validation', '候选分页游标与查询不匹配')
    const page: Array<Doc<'domainCandidateRows'>> = []
    let keyIndex = decoded?.kind === 'search' ? decoded.keyIndex : 0
    let cursor = decoded?.kind === 'search' ? decoded.cursor : null
    if (keyIndex < 0 || keyIndex > resolved.keys.length) throw synieError('validation', '候选分页游标不合法')
    while (page.length < input.numItems && keyIndex < resolved.keys.length) {
      const current = await ctx.db.query('domainCandidateRows').withSearchIndex('search_text', (q) =>
        q.search('searchText', search)
          .eq('resource', resource)
          .eq('profile', resolved.profile)
          .eq('key', resolved.keys[keyIndex]!),
      ).paginate({ numItems: input.numItems - page.length, cursor })
      page.push(...current.page)
      if (current.isDone) {
        keyIndex += 1
        cursor = null
      } else {
        cursor = current.continueCursor
      }
      if (page.length >= input.numItems) break
    }
    const isDone = keyIndex >= resolved.keys.length
    return {
      page,
      isDone,
      continueCursor: isDone ? '' : encodeCursor({
        v: 1,
        kind: 'search',
        fingerprint: expectedFingerprint,
        keyIndex,
        cursor,
      }),
    }
  }

  if (decoded?.kind === 'search') throw synieError('validation', '候选分页游标与查询不匹配')
  const last = decoded?.kind === 'sort' ? decoded.last : null
  const merged: Array<Doc<'domainCandidateRows'>> = []
  for (const key of resolved.keys) {
    const selected = await ctx.db.query('domainCandidateRows').withIndex('by_resource_profile_key_sort', (q) => {
      const prefix = q.eq('resource', resource).eq('profile', resolved.profile).eq('key', key)
      return last === null ? prefix : prefix.gt('sortValue', last)
    }).take(input.numItems + 1)
    merged.push(...selected)
  }
  merged.sort((left, right) => left.sortValue.localeCompare(right.sortValue) || left.recordId.localeCompare(right.recordId))
  const page = merged.slice(0, input.numItems)
  const isDone = merged.length <= input.numItems
  const final = page.at(-1)
  return {
    page,
    isDone,
    continueCursor: isDone || !final ? '' : encodeCursor({
      v: 1,
      kind: 'sort',
      fingerprint: expectedFingerprint,
      last: final.sortValue,
    }),
  }
}
