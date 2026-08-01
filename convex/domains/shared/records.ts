import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { canAccessCompany } from '../../lib/companyScope'
import { decimalToScaledInt64, scaledInt64ToDecimal } from '../../lib/decimal'
import { synieError, validationError } from '../../lib/errors'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { paginationOptions, requireSearchTerm, resourcePage } from '../../lib/pagination'
import { requirePermission } from '../../lib/permissions'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'
import { nextInMutation } from '../../platform/numbering/service'
import {
  domainEqualityFields,
  domainSortFields,
  replaceDomainQueryRows,
} from './queryProfiles'
import {
  AGGREGATE_HEADS,
  catalogDocument,
  decimalScaleForField,
  INITIAL_STATUS,
  NUMBER_FIELDS,
  PARENT_FIELDS,
  resourceHasCompanyScope,
  storeForResource,
  UNIQUE_GROUPS,
  type CatalogField,
  type ClosureStore,
} from './policies'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type RecordDoc = Doc<ClosureStore>
type WireRecord = Record<string, unknown>

export type DomainListInput = {
  numItems: number
  cursor?: string | null
  search?: string
  args?: Record<string, unknown>
}

const SYSTEM_FIELDS = new Set([
  'id', 'insertedAt', 'updatedAt', 'createdById', 'auditedById',
  'auditedAt', 'submittedById', 'shippedById', 'shippedAt',
  'receivedById', 'receivedAt', 'importedById', 'importedAt',
])

const FORMAL_TABLES: Readonly<Record<string, keyof DataModel>> = Object.freeze({
  basCurrencies: 'currencies', basCompanies: 'companies', basUnits: 'units',
  basAccounts: 'accounts', sysUsers: 'appUsers', sysRoles: 'iamRoles',
  sysRolePermissions: 'iamRolePermissions', sysAuditLogs: 'auditLogs',
  sysNumberingRules: 'numberingRules', sysNumberingCounters: 'numberingCounters',
  salCustomers: 'customers', purSuppliers: 'suppliers', hrEmployees: 'employees',
  salCompanyAccountDefaults: 'companyAccountDefaults',
  sysFiles: 'files',
  invMaterialCategories: 'materialCategories', invMaterials: 'materials',
  invMaterialUnits: 'materialUnits', invWarehouses: 'warehouses',
  salSettings: 'salesSettings', mfgSettings: 'manufacturingSettings',
  accSettings: 'accountingSettings', sysSettings: 'systemSettings',
})

const EDITABLE_STATUSES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  mfgBoms: ['DRAFT', 'INACTIVE'],
  mfgWorkOrders: ['IN_PROGRESS'],
  hrPayrolls: ['PENDING'],
})

function editableStatus(resource: string, status: string | null): boolean {
  return status === null || status === 'DRAFT' || (EDITABLE_STATUSES[resource]?.includes(status) ?? false)
}

function record(value: unknown, label = '参数'): WireRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', `${label}必须是对象`)
  }
  return value as WireRecord
}

function cleanString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value
}

function fieldAllows(field: CatalogField, mode: 'create' | 'update'): boolean {
  return field.input[mode] !== 'forbidden'
}

function fieldRequired(field: CatalogField, mode: 'create' | 'update'): boolean {
  return field.input[mode] === 'required'
}

function validateScalar(field: CatalogField, value: unknown): unknown {
  if (value === null) {
    if (!field.input.clearable) throw validationError('参数不合法', { [field.name]: ['不能为空'] })
    return null
  }
  if (field.kind === 'enum') {
    const text = String(value)
    if (!field.options?.some((option) => option.value === text)) {
      throw validationError('参数不合法', { [field.name]: ['不是允许的选项'] })
    }
    return text
  }
  if (field.kind === 'reference' || field.kind === 'polymorphicReference' || field.kind === 'uuid') {
    if (typeof value !== 'string' || !value.trim()) {
      throw validationError('参数不合法', { [field.name]: ['必须是有效标识'] })
    }
    return value.trim()
  }
  if (field.kind === 'json') return value
  if (field.name === 'times' && Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  if (field.scalarType === 'boolean') {
    if (typeof value !== 'boolean') throw validationError('参数不合法', { [field.name]: ['必须是布尔值'] })
    return value
  }
  if (field.scalarType === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw validationError('参数不合法', { [field.name]: ['必须是安全整数'] })
    }
    return value
  }
  if (field.scalarType === 'date') {
    const text = String(value)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw validationError('参数不合法', { [field.name]: ['必须是 YYYY-MM-DD 日期'] })
    }
    return text
  }
  if (field.scalarType === 'datetime') {
    const numeric = typeof value === 'number' ? value : Date.parse(String(value))
    if (!Number.isFinite(numeric)) throw validationError('参数不合法', { [field.name]: ['必须是有效时间'] })
    return value
  }
  if (field.scalarType === 'decimal') {
    if (typeof value !== 'string') throw validationError('参数不合法', { [field.name]: ['必须是十进制字符串'] })
    try {
      decimalToScaledInt64(value, decimalScaleForField(field))
    } catch {
      throw validationError('参数不合法', { [field.name]: ['必须是范围内的十进制字符串'] })
    }
    return value
  }
  if (field.scalarType === 'string' || field.kind === 'scalar') {
    if (typeof value !== 'string') throw validationError('参数不合法', { [field.name]: ['必须是字符串'] })
    return value.trim()
  }
  return cleanString(value)
}

function prepareWire(
  resource: string,
  input: unknown,
  mode: 'create' | 'update',
  previous?: WireRecord,
): WireRecord {
  const document = catalogDocument(resource)
  const source = record(input)
  const next: WireRecord = previous ? { ...previous } : {}
  const known = new Set(document.fields.map((field) => field.name))
  for (const key of Object.keys(source)) {
    if (!known.has(key) && !SYSTEM_FIELDS.has(key)) {
      throw validationError('参数不合法', { [key]: ['Catalog 未声明该字段'] })
    }
  }
  for (const field of document.fields) {
    if (SYSTEM_FIELDS.has(field.name) || !fieldAllows(field, mode)) continue
    if (!(field.name in source)) {
      if (mode === 'create' && fieldRequired(field, mode)) {
        throw validationError('参数不合法', { [field.name]: ['不能为空'] })
      }
      continue
    }
    const value = source[field.name]
    if ((value === '' || value === undefined || value === null) && fieldRequired(field, mode)) {
      throw validationError('参数不合法', { [field.name]: ['不能为空'] })
    }
    if (value === undefined) continue
    if (value === '' && field.input.clearable) next[field.name] = null
    else next[field.name] = validateScalar(field, value)
  }
  return next
}

function encodeDecimals(resource: string, wire: WireRecord): { data: WireRecord; decimalValues: Record<string, bigint> } {
  const data = { ...wire }
  const decimalValues: Record<string, bigint> = {}
  for (const field of catalogDocument(resource).fields) {
    if (field.scalarType !== 'decimal') continue
    const value = data[field.name]
    delete data[field.name]
    if (value === null || value === undefined || value === '') continue
    decimalValues[field.name] = decimalToScaledInt64(String(value), decimalScaleForField(field))
  }
  return { data, decimalValues }
}

function hydrate(row: RecordDoc): WireRecord {
  const document = catalogDocument(row.resource)
  const result: WireRecord = {
    ...record(row.data, '存储记录'),
    id: row._id,
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
  }
  if (row.companyId !== null) result.companyId = row.companyId
  if (row.status !== null) result.status = row.status
  const decimals = record(row.decimalValues ?? {}, '定标十进制')
  for (const field of document.fields) {
    if (field.scalarType !== 'decimal') continue
    const scaled = decimals[field.name]
    result[field.name] = typeof scaled === 'bigint'
      ? scaledInt64ToDecimal(scaled, decimalScaleForField(field))
      : null
  }
  return result
}

function labelFor(resource: string, wire: WireRecord): string {
  const document = catalogDocument(resource)
  const value = wire[document.lookup.labelField]
  if (value !== null && value !== undefined && String(value).trim()) return String(value)
  for (const candidate of ['docNo', 'voucherNo', 'orderNo', 'receiptNo', 'quotationNo', 'deliveryNo', 'issueNo', 'outputNo', 'workOrderNo', 'demandNo', 'code', 'name']) {
    if (wire[candidate] !== null && wire[candidate] !== undefined && String(wire[candidate]).trim()) return String(wire[candidate])
  }
  return document.label
}

function searchTextFor(resource: string, wire: WireRecord): string {
  const document = catalogDocument(resource)
  const fields = new Set([document.lookup.labelField, ...document.lookup.searchFields])
  return [...fields]
    .map((field) => wire[field])
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
}

function sortKeyFor(resource: string, wire: WireRecord): string {
  return labelFor(resource, wire).normalize('NFKC').toLocaleLowerCase('en-US')
}

function requireCompany(actor: Actor, companyId: unknown): string {
  if (typeof companyId !== 'string' || !companyId.trim()) throw synieError('validation', '公司不能为空')
  if (!canAccessCompany(actor, companyId)) throw synieError('not_found', '公司不存在')
  return companyId
}

async function getStored(ctx: QueryCtx | MutationCtx, resource: string, id: string): Promise<RecordDoc | null> {
  const table = storeForResource(resource)
  if (!table) throw synieError('validation', `资源 ${resource} 不属于事务闭包记录面`)
  const normalized = ctx.db.normalizeId(table, id)
  if (!normalized) return null
  const row = await ctx.db.get(normalized) as RecordDoc | null
  return row?.resource === resource ? row : null
}

async function resourceExists(ctx: QueryCtx | MutationCtx, resource: string, id: string): Promise<boolean> {
  const formal = FORMAL_TABLES[resource]
  if (formal) {
    const normalized = ctx.db.normalizeId(formal, id)
    return Boolean(normalized && await ctx.db.get(normalized as never))
  }
  return Boolean(await getStored(ctx, resource, id))
}

async function referencedCompanyId(
  ctx: QueryCtx | MutationCtx,
  resource: string,
  id: string,
): Promise<string | null> {
  if (resource === 'basAccounts') {
    const normalized = ctx.db.normalizeId('accounts', id)
    return normalized ? (await ctx.db.get(normalized))?.companyId ?? null : null
  }
  if (resource === 'invWarehouses') {
    const normalized = ctx.db.normalizeId('warehouses', id)
    return normalized ? (await ctx.db.get(normalized))?.companyId ?? null : null
  }
  if (resource === 'salCompanyAccountDefaults') {
    const normalized = ctx.db.normalizeId('companyAccountDefaults', id)
    return normalized ? (await ctx.db.get(normalized))?.companyId ?? null : null
  }
  if (FORMAL_TABLES[resource]) return null
  return (await getStored(ctx, resource, id))?.companyId ?? null
}

async function assertReferences(ctx: QueryCtx | MutationCtx, resource: string, wire: WireRecord): Promise<void> {
  for (const field of catalogDocument(resource).fields) {
    const raw = wire[field.name]
    if (raw === null || raw === undefined || raw === '') continue
    let target = field.kind === 'reference' ? field.targetResource : undefined
    if (field.kind === 'polymorphicReference') {
      const discriminator = field.discriminator ? wire[field.discriminator] : undefined
      target = field.variants?.find((variant) => variant.value === discriminator)?.resource
      if (!target) throw validationError('参数不合法', { [field.name]: ['对手类型与资源不匹配'] })
    }
    if (!target) continue
    if (!await resourceExists(ctx, target, String(raw))) {
      throw validationError('参数不合法', { [field.name]: ['关联记录不存在'] })
    }
    const ownerCompanyId = typeof wire.companyId === 'string' ? wire.companyId : null
    const targetCompanyId = await referencedCompanyId(ctx, target, String(raw))
    if (ownerCompanyId && targetCompanyId && ownerCompanyId !== targetCompanyId) {
      throw validationError('参数不合法', { [field.name]: ['关联记录不属于当前公司'] })
    }
  }
}

async function replaceReferenceWitnesses(
  ctx: MutationCtx,
  resource: string,
  recordId: string,
  wire: WireRecord,
): Promise<void> {
  const old = await ctx.db.query('domainReferences').withIndex('by_source', (q) =>
    q.eq('sourceResource', resource).eq('sourceRecordId', recordId),
  ).collect()
  for (const row of old) await ctx.db.delete(row._id)
  for (const field of catalogDocument(resource).fields) {
    const value = wire[field.name]
    if (value === null || value === undefined || value === '') continue
    let target = field.kind === 'reference' ? field.targetResource : undefined
    if (field.kind === 'polymorphicReference') {
      const discriminator = field.discriminator ? wire[field.discriminator] : undefined
      target = field.variants?.find((variant) => variant.value === discriminator)?.resource
    }
    if (!target) continue
    await ctx.db.insert('domainReferences', {
      sourceResource: resource,
      sourceRecordId: recordId,
      field: field.name,
      targetResource: target,
      targetRecordId: String(value),
    })
  }
}

const ATTENDANCE_INDEXED = new Set(['hrAttendancePunches', 'hrAttendanceCorrections', 'hrAttendanceDays'])

function attendanceDate(resource: string, wire: WireRecord): string | null {
  if (resource !== 'hrAttendancePunches') {
    return typeof wire.date === 'string' ? wire.date : null
  }
  const instant = typeof wire.punchedAt === 'number'
    ? wire.punchedAt
    : Date.parse(String(wire.punchedAt ?? ''))
  if (!Number.isFinite(instant)) return null
  return new Date(instant + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

async function replaceAttendanceIndex(
  ctx: MutationCtx,
  resource: string,
  recordId: string,
  wire: WireRecord | null,
): Promise<void> {
  if (!ATTENDANCE_INDEXED.has(resource)) return
  const old = await ctx.db.query('hrAttendanceIndex').withIndex('by_record', (q) =>
    q.eq('resource', resource as 'hrAttendancePunches').eq('recordId', recordId),
  ).collect()
  for (const row of old) await ctx.db.delete(row._id)
  if (!wire) return
  const date = attendanceDate(resource, wire)
  if (!date || typeof wire.employeeId !== 'string') throw synieError('validation', '考勤索引缺少员工或日期')
  await ctx.db.insert('hrAttendanceIndex', {
    resource: resource as 'hrAttendancePunches' | 'hrAttendanceCorrections' | 'hrAttendanceDays',
    recordId,
    employeeId: wire.employeeId,
    date,
  })
}

function uniqueKey(wire: WireRecord, fields: readonly string[]): string | null {
  const values: string[] = []
  for (const field of fields) {
    const value = wire[field]
    if (value === null || value === undefined || String(value).trim() === '') return null
    values.push(String(value).trim().normalize('NFKC').toLocaleLowerCase('en-US'))
  }
  return JSON.stringify(values)
}

async function replaceUniqueClaims(ctx: MutationCtx, resource: string, recordId: string, wire: WireRecord): Promise<void> {
  const old = await ctx.db.query('domainUniqueClaims').withIndex('by_record', (q) =>
    q.eq('resource', resource).eq('recordId', recordId),
  ).collect()
  for (const row of old) await ctx.db.delete(row._id)
  const scopeKey = resourceHasCompanyScope(resource) ? String(wire.companyId ?? '') : 'global'
  for (const fields of UNIQUE_GROUPS[resource] ?? []) {
    const key = uniqueKey(wire, fields)
    if (!key) continue
    const existing = await ctx.db.query('domainUniqueClaims').withIndex('by_claim', (q) =>
      q.eq('resource', resource).eq('scopeKey', scopeKey).eq('uniqueKey', key),
    ).unique()
    if (existing && existing.recordId !== recordId) {
      throw synieError('conflict', `${catalogDocument(resource).label}的唯一字段已存在`)
    }
    await ctx.db.insert('domainUniqueClaims', { resource, scopeKey, uniqueKey: key, recordId })
  }
}

const NUMBERING_BINDINGS: Readonly<Record<string, {
  numberingResource: string
  fields: Readonly<Record<string, string>>
}>> = Object.freeze({
  mfgOperations: { numberingResource: 'mfg.operation', fields: { name: 'name' } },
  mfgProcessTemplates: { numberingResource: 'mfg.route_template', fields: { name: 'name' } },
  mfgBoms: { numberingResource: 'mfg.bom', fields: { materialId: 'material_id' } },
  invStockDocs: { numberingResource: 'inv.stock_doc', fields: { docDate: 'doc_date' } },
  invStockTransfers: { numberingResource: 'inv.stock_transfer', fields: { docDate: 'doc_date' } },
  invStockCounts: { numberingResource: 'inv.stock_count', fields: { postingDate: 'posting_date' } },
  accGlJournals: { numberingResource: 'acc.gl_journal', fields: { date: 'date', postingDate: 'posting_date' } },
  salQuotations: { numberingResource: 'sales.quotation', fields: { quotationDate: 'quotation_date', validUntil: 'valid_until' } },
  salOrders: { numberingResource: 'sales.order', fields: { orderDate: 'order_date' } },
  salDeliveries: { numberingResource: 'sales.delivery', fields: { deliveryDate: 'delivery_date', postingDate: 'posting_date' } },
  salReconciliations: { numberingResource: 'sales.reconciliation', fields: { postingDate: 'posting_date' } },
  purQuotations: { numberingResource: 'purchase.quotation', fields: { quotationDate: 'quotation_date', validUntil: 'valid_until' } },
  purOrders: { numberingResource: 'purchase.order', fields: { orderDate: 'order_date' } },
  purReceipts: { numberingResource: 'purchase.receipt', fields: { receiptDate: 'receipt_date', postingDate: 'posting_date' } },
  purReconciliations: { numberingResource: 'purchase.reconciliation', fields: { postingDate: 'posting_date' } },
  purOutsourcedIssues: { numberingResource: 'purchase.outsourced_issue', fields: { issueDate: 'issue_date' } },
  purOutsourcedReceipts: { numberingResource: 'purchase.outsourced_receipt', fields: { receiptDate: 'receipt_date', postingDate: 'posting_date' } },
  accVatInvoices: { numberingResource: 'acc.vat_invoice', fields: { invoiceDate: 'invoice_date', postingDate: 'posting_date' } },
  accExpenseReports: { numberingResource: 'acc.expense_report', fields: { expenseDate: 'expense_date', postingDate: 'posting_date' } },
  accBillTransactions: { numberingResource: 'acc.bill_transaction', fields: { occurredOn: 'occurred_on', postingDate: 'posting_date' } },
  mfgDemands: { numberingResource: 'mfg.demand', fields: { demandDate: 'demand_date' } },
  mfgWorkOrders: { numberingResource: 'mfg.work_order', fields: { needDate: 'need_date' } },
  mfgOutputs: { numberingResource: 'mfg.output', fields: { outputDate: 'output_date' } },
})

async function prepareCreate(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  input: unknown,
): Promise<WireRecord> {
  const source = { ...record(input) }
  const numberField = NUMBER_FIELDS[resource]
  if (numberField && (source[numberField] === undefined || source[numberField] === null || source[numberField] === '')) {
    const binding = NUMBERING_BINDINGS[resource]
    if (!binding) throw synieError('internal', `${resource} 缺少正式编号绑定`)
    const values: Record<string, unknown> = { company_id: source.companyId }
    for (const [wireField, numberingField] of Object.entries(binding.fields)) {
      values[numberingField] = source[wireField]
    }
    source[numberField] = await nextInMutation(asDomainMutationCtx(ctx), binding.numberingResource, values)
  }
  const wire = prepareWire(resource, source, 'create')
  if (INITIAL_STATUS[resource]) wire.status = INITIAL_STATUS[resource]
  if (catalogDocument(resource).fields.some((field) => field.name === 'createdById')) wire.createdById = actor.userId
  return wire
}

async function deriveParentAndCompany(
  ctx: QueryCtx | MutationCtx,
  actor: Actor,
  resource: string,
  wire: WireRecord,
): Promise<{ parentId: string | null; companyId: string | null }> {
  const parentField = PARENT_FIELDS[resource]
  let parentId = parentField && typeof wire[parentField] === 'string' ? String(wire[parentField]) : null
  let parent: RecordDoc | null = null
  if (parentId) {
    const target = catalogDocument(resource).fields.find((field) => field.name === parentField)?.targetResource
    if (!target) throw synieError('internal', `${resource}.${parentField} 缺少父资源声明`)
    parent = await getStored(ctx, target, parentId)
    if (!parent) throw validationError('参数不合法', { [parentField]: ['父记录不存在'] })
    if (parent.companyId !== null) wire.companyId = parent.companyId
  }
  const companyId = resourceHasCompanyScope(resource) || wire.companyId !== undefined
    ? requireCompany(actor, wire.companyId)
    : parent?.companyId ?? null
  return { parentId, companyId }
}

export async function getDomainRecord(
  ctx: QueryCtx | MutationCtx,
  actor: Actor,
  resource: string,
  id: string,
): Promise<WireRecord | null> {
  const document = catalogDocument(resource)
  requirePermission(actor, `${document.permissionPrefix}:read`)
  const row = await getStored(ctx, resource, id)
  if (!row) return null
  if (row.companyId !== null && !canAccessCompany(actor, row.companyId)) return null
  if (!await importRecordVisible(ctx, row)) return null
  return hydrate(row)
}

async function importRecordVisible(ctx: QueryCtx | MutationCtx, row: RecordDoc): Promise<boolean> {
  const internal = row.internalState && typeof row.internalState === 'object' && !Array.isArray(row.internalState)
    ? row.internalState as Record<string, unknown>
    : null
  if (row.resource === 'accBankTransactions' && typeof internal?.bankImportId === 'string') {
    const id = ctx.db.normalizeId('financeDocuments', internal.bankImportId)
    const parent = id ? await ctx.db.get(id) : null
    return parent?.resource === 'accBankImports' && parent.status === 'IMPORTED'
  }
  if (row.resource === 'hrAttendancePunches') {
    const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
      ? row.data as Record<string, unknown>
      : null
    if (typeof data?.importId === 'string') {
      const id = ctx.db.normalizeId('hrDocuments', data.importId)
      const parent = id ? await ctx.db.get(id) : null
      return parent?.resource === 'hrAttendanceImports' && parent.status === 'IMPORTED'
    }
  }
  return true
}

async function visibleRecords(ctx: QueryCtx, rows: readonly RecordDoc[]): Promise<RecordDoc[]> {
  const visible: RecordDoc[] = []
  for (const row of rows) if (await importRecordVisible(ctx, row)) visible.push(row)
  return visible
}

function offsetCursor(value: string | null | undefined): number {
  if (!value) return 0
  const match = /^domain-offset:(\d+)$/.exec(value)
  if (!match) throw synieError('validation', '分页游标不合法')
  const result = Number(match[1])
  if (!Number.isSafeInteger(result) || result < 0 || result > 4_000) throw synieError('validation', '分页游标超出范围')
  return result
}

async function scopedOffsetPage(
  ctx: QueryCtx,
  table: ClosureStore,
  resource: string,
  actor: Actor,
  input: DomainListInput,
  search: string | null,
  status: string | null,
) {
  const offset = offsetCursor(input.cursor)
  const rows: RecordDoc[] = []
  for (const companyId of actor.companyIds) {
    const selected = search
      ? await ctx.db.query(table).withSearchIndex('search_text', (q) =>
          status
            ? q.search('searchText', search).eq('resource', resource).eq('companyId', companyId).eq('status', status)
            : q.search('searchText', search).eq('resource', resource).eq('companyId', companyId),
        ).take(offset + input.numItems)
      : status
        ? await ctx.db.query(table).withIndex('by_resource_company_status_sort', (q) =>
            q.eq('resource', resource).eq('companyId', companyId).eq('status', status),
          ).take(offset + input.numItems)
        : await ctx.db.query(table).withIndex('by_resource_company_sort', (q) =>
            q.eq('resource', resource).eq('companyId', companyId),
          ).take(offset + input.numItems)
    rows.push(...selected as RecordDoc[])
  }
  rows.sort((left, right) => left.sortKey.localeCompare(right.sortKey) || String(left._id).localeCompare(String(right._id)))
  const page = await visibleRecords(ctx, rows.slice(offset, offset + input.numItems))
  const next = offset + page.length
  return {
    results: page.map(hydrate),
    pageInfo: {
      continueCursor: page.length === input.numItems ? `domain-offset:${next}` : null,
      isDone: page.length < input.numItems,
    },
  }
}

type QueryProjection = Doc<'domainQueryRows'>

async function hydrateProjectionPage(
  ctx: QueryCtx,
  table: ClosureStore,
  resource: string,
  rows: readonly QueryProjection[],
): Promise<WireRecord[]> {
  const result: WireRecord[] = []
  for (const projection of rows) {
    const normalized = ctx.db.normalizeId(table, projection.recordId)
    const row = normalized ? await ctx.db.get(normalized as never) as RecordDoc | null : null
    if (!row || row.resource !== resource) {
      throw synieError('internal', `${resource} 查询投影指向不存在的记录`)
    }
    if (await importRecordVisible(ctx, row)) result.push(hydrate(row))
  }
  return result
}

async function sortedRestrictedOffsetPage(
  ctx: QueryCtx,
  table: ClosureStore,
  resource: string,
  actor: Actor,
  profile: string,
  direction: 'asc' | 'desc',
  status: string | null,
  input: DomainListInput,
) {
  const offset = offsetCursor(input.cursor)
  const rows: QueryProjection[] = []
  for (const companyId of actor.companyIds) {
    const selected = status
      ? await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_company_status_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile).eq('companyId', companyId).eq('status', status),
        ).order(direction).take(offset + input.numItems)
      : await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_company_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile).eq('companyId', companyId),
        ).order(direction).take(offset + input.numItems)
    rows.push(...selected)
  }
  rows.sort((left, right) => {
    const comparison = left.sortValue.localeCompare(right.sortValue) || left.recordId.localeCompare(right.recordId)
    return direction === 'asc' ? comparison : -comparison
  })
  const selected = rows.slice(offset, offset + input.numItems)
  const next = offset + selected.length
  return {
    results: await hydrateProjectionPage(ctx, table, resource, selected),
    pageInfo: {
      continueCursor: selected.length === input.numItems ? `domain-offset:${next}` : null,
      isDone: selected.length < input.numItems,
    },
  }
}

async function listProjectedRecords(
  ctx: QueryCtx,
  table: ClosureStore,
  resource: string,
  actor: Actor,
  input: DomainListInput,
  options: {
    sortField: string | null
    sortDirection: 'ascending' | 'descending'
    companyId: string | null
    parentId: string | null
    status: string | null
    equality: { field: string; value: string } | null
  },
) {
  const profile = options.sortField ? `sort:${options.sortField}` : 'sort:default'
  const direction = options.sortDirection === 'descending' ? 'desc' : 'asc'
  if (options.equality) {
    if (options.companyId || options.parentId || options.sortField) {
      throw synieError('validation', '等值 query profile 不能与公司、父记录或自定义排序组合')
    }
    const page = options.status
      ? await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_equality_status_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile)
            .eq('equalityField', options.equality!.field).eq('equalityValue', options.equality!.value)
            .eq('status', options.status),
        ).order(direction).paginate(paginationOptions(input))
      : await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_equality_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile)
            .eq('equalityField', options.equality!.field).eq('equalityValue', options.equality!.value),
        ).order(direction).paginate(paginationOptions(input))
    return resourcePage({ ...page, page: await hydrateProjectionPage(ctx, table, resource, page.page) })
  }
  if (options.parentId) {
    const page = await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_parent_sort', (q) =>
      q.eq('resource', resource).eq('profile', profile).eq('parentId', options.parentId),
    ).order(direction).paginate(paginationOptions(input))
    return resourcePage({ ...page, page: await hydrateProjectionPage(ctx, table, resource, page.page) })
  }
  if (resourceHasCompanyScope(resource) && !options.companyId && !actor.superAdmin && !actor.allCompanies) {
    return sortedRestrictedOffsetPage(ctx, table, resource, actor, profile, direction, options.status, input)
  }
  const page = options.companyId
    ? options.status
      ? await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_company_status_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile).eq('companyId', options.companyId).eq('status', options.status),
        ).order(direction).paginate(paginationOptions(input))
      : await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_company_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile).eq('companyId', options.companyId),
        ).order(direction).paginate(paginationOptions(input))
    : options.status
      ? await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_status_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile).eq('status', options.status),
        ).order(direction).paginate(paginationOptions(input))
      : await ctx.db.query('domainQueryRows').withIndex('by_resource_profile_sort', (q) =>
          q.eq('resource', resource).eq('profile', profile),
        ).order(direction).paginate(paginationOptions(input))
  return resourcePage({ ...page, page: await hydrateProjectionPage(ctx, table, resource, page.page) })
}

export async function listDomainRecords(
  ctx: QueryCtx,
  actor: Actor,
  resource: string,
  input: DomainListInput,
) {
  const document = catalogDocument(resource)
  requirePermission(actor, `${document.permissionPrefix}:read`)
  const table = storeForResource(resource)
  if (!table) throw synieError('validation', `资源 ${resource} 不属于该领域记录面`)
  paginationOptions(input)
  const args = input.args ?? {}
  const allowed = new Set([
    'companyId', 'parentId', 'status', 'sortField', 'sortDirection',
    ...domainEqualityFields(resource),
  ])
  const unsupported = Object.keys(args).filter((key) => !allowed.has(key))
  if (unsupported.length) throw synieError('validation', `未声明的查询参数: ${unsupported.join(',')}`)
  const companyId = typeof args.companyId === 'string' && args.companyId ? requireCompany(actor, args.companyId) : null
  const parentId = typeof args.parentId === 'string' && args.parentId ? args.parentId : null
  const status = typeof args.status === 'string' && args.status ? args.status : null
  const sortField = typeof args.sortField === 'string' && args.sortField ? args.sortField : null
  const sortDirection = args.sortDirection === 'descending' ? 'descending' : 'ascending'
  if (args.sortDirection !== undefined && args.sortDirection !== 'ascending' && args.sortDirection !== 'descending') {
    throw synieError('validation', '排序方向不合法')
  }
  if (sortField && !domainSortFields(resource).includes(sortField)) {
    throw synieError('validation', `${resource} 未声明排序字段 ${sortField}`)
  }
  const equalities = domainEqualityFields(resource)
    .filter((field) => typeof args[field] === 'string' && String(args[field]).trim())
    .map((field) => ({ field, value: String(args[field]).trim() }))
  if (equalities.length > 1) throw synieError('validation', '一次只能使用一个等值 query profile')
  const equality = equalities[0] ?? null
  const search = input.search === undefined ? null : requireSearchTerm(input.search)
  if (parentId && (companyId || status || search)) throw synieError('validation', '父记录查询不能与其他 profile 组合')
  if (search && (sortField || equality)) throw synieError('validation', '搜索 profile 不支持额外排序或等值筛选')

  if (parentId) {
    const parentTarget = catalogDocument(resource).fields.find((field) => field.name === PARENT_FIELDS[resource])?.targetResource
    if (!parentTarget) throw synieError('validation', '资源不支持父记录查询')
    const parent = await getStored(ctx, parentTarget, parentId)
    if (!parent || (parent.companyId !== null && !canAccessCompany(actor, parent.companyId))) {
      throw synieError('not_found', '父记录不存在')
    }
  }

  if (sortField || equality) {
    return listProjectedRecords(ctx, table, resource, actor, input, {
      sortField, sortDirection, companyId, parentId, status, equality,
    })
  }

  if (parentId) {
    const page = await ctx.db.query(table).withIndex('by_resource_parent_sort', (q) =>
      q.eq('resource', resource).eq('parentId', parentId),
    ).paginate(paginationOptions(input))
    return resourcePage({ ...page, page: (await visibleRecords(ctx, page.page as RecordDoc[])).map(hydrate) })
  }
  if (status && !companyId && !search && (!resourceHasCompanyScope(resource) || actor.superAdmin || actor.allCompanies)) {
    const page = await ctx.db.query(table).withIndex('by_resource_status_sort', (q) =>
      q.eq('resource', resource).eq('status', status),
    ).paginate(paginationOptions(input))
    const rows = (await visibleRecords(ctx, page.page as RecordDoc[])).filter((row) => row.companyId === null || canAccessCompany(actor, row.companyId))
    return resourcePage({ ...page, page: rows.map(hydrate) })
  }
  if (resourceHasCompanyScope(resource) && !companyId && !actor.superAdmin && !actor.allCompanies) {
    return scopedOffsetPage(ctx, table, resource, actor, input, search, status)
  }
  const options = paginationOptions(input)
  const page = search
    ? await ctx.db.query(table).withSearchIndex('search_text', (q) => {
        const base = q.search('searchText', search).eq('resource', resource)
        const scoped = companyId ? base.eq('companyId', companyId) : base
        return status ? scoped.eq('status', status) : scoped
      }).paginate(options)
    : companyId
      ? status
        ? await ctx.db.query(table).withIndex('by_resource_company_status_sort', (q) =>
            q.eq('resource', resource).eq('companyId', companyId).eq('status', status),
          ).paginate(options)
        : await ctx.db.query(table).withIndex('by_resource_company_sort', (q) =>
            q.eq('resource', resource).eq('companyId', companyId),
          ).paginate(options)
      : await ctx.db.query(table).withIndex('by_resource_sort', (q) => q.eq('resource', resource)).paginate(options)
  return resourcePage({ ...page, page: (await visibleRecords(ctx, page.page as RecordDoc[])).map(hydrate) })
}

export async function createDomainRecord(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  input: unknown,
  options: { allowAggregateHead?: boolean; permissionChecked?: boolean; trustedDerived?: WireRecord } = {},
): Promise<WireRecord> {
  const document = catalogDocument(resource)
  if (!options.permissionChecked && !document.capabilities.includes('create')) {
    throw synieError('validation', `${document.label}不支持普通创建`)
  }
  if (!options.permissionChecked) requirePermission(actor, `${document.permissionPrefix}:create`)
  if (AGGREGATE_HEADS.has(resource) && !options.allowAggregateHead) {
    throw synieError('validation', '聚合表头只能经完整草稿入口创建')
  }
  const table = storeForResource(resource)
  if (!table) throw synieError('validation', `资源 ${resource} 不属于该领域记录面`)
  const trustedInput = options.trustedDerived
    ? { ...record(input), ...options.trustedDerived }
    : input
  const wire = await prepareCreate(ctx, actor, resource, trustedInput)
  Object.assign(wire, options.trustedDerived ?? {})
  const { parentId, companyId } = await deriveParentAndCompany(ctx, actor, resource, wire)
  await assertReferences(ctx, resource, wire)
  const now = Date.now()
  const encoded = encodeDecimals(resource, wire)
  const id = await ctx.db.insert(table, {
    resource, companyId, parentId, status: typeof wire.status === 'string' ? wire.status : null,
    sortKey: sortKeyFor(resource, wire), searchText: searchTextFor(resource, wire),
    decimalValues: encoded.decimalValues, data: encoded.data, insertedAt: now, updatedAt: now,
  } as never)
  const recordId = String(id)
  try {
    await replaceUniqueClaims(ctx, resource, recordId, wire)
    await replaceReferenceWitnesses(ctx, resource, recordId, wire)
    await replaceAttendanceIndex(ctx, resource, recordId, wire)
    await replaceDomainQueryRows(ctx, resource, recordId, wire, { companyId, parentId, status: typeof wire.status === 'string' ? wire.status : null })
  } catch (error) {
    throw error
  }
  const result = hydrate((await ctx.db.get(id as never)) as RecordDoc)
  await writeAudit(asDomainMutationCtx(ctx), actor, {
    resource, recordId, recordLabel: labelFor(resource, result), companyId,
    action: 'create', changes: result,
  })
  return result
}

export async function updateDomainRecord(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  input: unknown,
  options: { allowAggregateHead?: boolean; permissionChecked?: boolean; trustedDerived?: WireRecord } = {},
): Promise<WireRecord> {
  const document = catalogDocument(resource)
  if (!options.permissionChecked && !document.capabilities.includes('update')) {
    throw synieError('validation', `${document.label}不支持普通修改`)
  }
  if (!options.permissionChecked) requirePermission(actor, `${document.permissionPrefix}:update`)
  if (AGGREGATE_HEADS.has(resource) && !options.allowAggregateHead) {
    throw synieError('validation', '聚合表头只能经完整草稿入口替换')
  }
  const row = await getStored(ctx, resource, id)
  if (!row) throw synieError('not_found', `${document.label}不存在`)
  if (row.companyId !== null) requireCompany(actor, row.companyId)
  if (!options.permissionChecked && !editableStatus(resource, row.status)) {
    throw synieError('conflict', '只有草稿记录可以修改')
  }
  const before = hydrate(row)
  const trustedInput = options.trustedDerived
    ? { ...record(input), ...options.trustedDerived }
    : input
  const wire = prepareWire(resource, trustedInput, 'update', before)
  Object.assign(wire, options.trustedDerived ?? {})
  // Immutable ownership/system facts never come from an update payload.
  wire.companyId = before.companyId
  wire.status = before.status
  for (const field of SYSTEM_FIELDS) if (field in before) wire[field] = before[field]
  const { parentId, companyId } = await deriveParentAndCompany(ctx, actor, resource, wire)
  await assertReferences(ctx, resource, wire)
  await replaceUniqueClaims(ctx, resource, id, wire)
  await replaceReferenceWitnesses(ctx, resource, id, wire)
  await replaceAttendanceIndex(ctx, resource, id, wire)
  const encoded = encodeDecimals(resource, wire)
  await ctx.db.patch(row._id, {
    companyId, parentId, status: typeof wire.status === 'string' ? wire.status : null,
    sortKey: sortKeyFor(resource, wire), searchText: searchTextFor(resource, wire),
    decimalValues: encoded.decimalValues, data: encoded.data, updatedAt: Date.now(),
  })
  const after = hydrate((await ctx.db.get(row._id)) as RecordDoc)
  await replaceDomainQueryRows(ctx, resource, id, after, { companyId, parentId, status: typeof after.status === 'string' ? after.status : null })
  const changes = changedFields(before, after)
  if (Object.keys(changes).length) {
    await writeAudit(asDomainMutationCtx(ctx), actor, {
      resource, recordId: id, recordLabel: labelFor(resource, after), companyId,
      action: 'update', changes,
    })
  }
  return after
}

export async function removeDomainRecord(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  options: { permissionChecked?: boolean } = {},
): Promise<void> {
  const document = catalogDocument(resource)
  if (!options.permissionChecked && !document.capabilities.includes('delete')) {
    throw synieError('validation', `${document.label}不支持删除`)
  }
  if (!options.permissionChecked) requirePermission(actor, `${document.permissionPrefix}:delete`)
  const row = await getStored(ctx, resource, id)
  if (!row) throw synieError('not_found', `${document.label}不存在`)
  if (row.companyId !== null) requireCompany(actor, row.companyId)
  if (!options.permissionChecked && !editableStatus(resource, row.status)) throw synieError('conflict', '当前状态不可删除')
  const reference = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
    q.eq('targetResource', resource).eq('targetRecordId', id),
  ).first()
  if (reference) throw synieError('conflict', `${document.label}已被业务数据引用,不可删除`)
  const before = hydrate(row)
  const [claims, witnesses] = await Promise.all([
    ctx.db.query('domainUniqueClaims').withIndex('by_record', (q) => q.eq('resource', resource).eq('recordId', id)).collect(),
    ctx.db.query('domainReferences').withIndex('by_source', (q) => q.eq('sourceResource', resource).eq('sourceRecordId', id)).collect(),
  ])
  for (const claim of claims) await ctx.db.delete(claim._id)
  for (const witness of witnesses) await ctx.db.delete(witness._id)
  await replaceAttendanceIndex(ctx, resource, id, null)
  await replaceDomainQueryRows(ctx, resource, id, null)
  await ctx.db.delete(row._id)
  await writeAudit(asDomainMutationCtx(ctx), actor, {
    resource, recordId: id, recordLabel: labelFor(resource, before), companyId: row.companyId,
    action: 'destroy', changes: before,
  })
}

export async function patchDomainStatus(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  nextStatus: string,
  action: string,
  extra: WireRecord = {},
): Promise<WireRecord> {
  const row = await getStored(ctx, resource, id)
  if (!row) throw synieError('not_found', `${catalogDocument(resource).label}不存在`)
  if (row.companyId !== null) requireCompany(actor, row.companyId)
  const before = hydrate(row)
  const now = Date.now()
  const wire: WireRecord = { ...before, ...extra, status: nextStatus }
  if (action === 'audit' || action === 'approve') {
    wire.auditedById = actor.userId
    wire.auditedAt = now
  }
  const encoded = encodeDecimals(resource, wire)
  await ctx.db.patch(row._id, {
    status: nextStatus, data: encoded.data, decimalValues: encoded.decimalValues,
    sortKey: sortKeyFor(resource, wire), searchText: searchTextFor(resource, wire), updatedAt: now,
  })
  const after = hydrate((await ctx.db.get(row._id)) as RecordDoc)
  // Commands may clear or replace reference fields (for example invoice void/reverse).
  // Keep the indexed FK witness projection in the same transaction as the status change.
  await replaceReferenceWitnesses(ctx, resource, id, after)
  await replaceDomainQueryRows(ctx, resource, id, after, { companyId: row.companyId, parentId: row.parentId, status: nextStatus })
  await writeAudit(asDomainMutationCtx(ctx), actor, {
    resource, recordId: id, recordLabel: labelFor(resource, after), companyId: row.companyId,
    action, changes: changedFields(before, after),
  })
  return after
}

/** Internal controlled projection update; callers are explicit domain commands. */
export async function patchDomainComputed(
  ctx: MutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  patch: WireRecord,
  action: string,
): Promise<WireRecord> {
  const row = await getStored(ctx, resource, id)
  if (!row) throw synieError('not_found', `${catalogDocument(resource).label}不存在`)
  const before = hydrate(row)
  const wire: WireRecord = { ...before, ...patch }
  const encoded = encodeDecimals(resource, wire)
  await ctx.db.patch(row._id, {
    status: typeof wire.status === 'string' ? wire.status : row.status,
    data: encoded.data,
    decimalValues: encoded.decimalValues,
    sortKey: sortKeyFor(resource, wire),
    searchText: searchTextFor(resource, wire),
    updatedAt: Date.now(),
  })
  const after = hydrate((await ctx.db.get(row._id)) as RecordDoc)
  await replaceDomainQueryRows(ctx, resource, id, after, {
    companyId: row.companyId,
    parentId: row.parentId,
    status: typeof after.status === 'string' ? after.status : row.status,
  })
  const changes = changedFields(before, after)
  if (Object.keys(changes).length) {
    await writeAudit(asDomainMutationCtx(ctx), actor, {
      resource, recordId: id, recordLabel: labelFor(resource, after), companyId: row.companyId,
      action, changes,
    })
  }
  return after
}

export async function childrenFor(
  ctx: QueryCtx | MutationCtx,
  resource: string,
  parentId: string,
): Promise<WireRecord[]> {
  const table = storeForResource(resource)
  if (!table) throw synieError('internal', `子资源 ${resource} 没有闭包存储`)
  const rows = await ctx.db.query(table).withIndex('by_resource_parent_sort', (q) =>
    q.eq('resource', resource).eq('parentId', parentId),
  ).collect()
  return (rows as RecordDoc[]).map(hydrate)
}

export async function unsafeStoredForMutation(ctx: MutationCtx, resource: string, id: string): Promise<RecordDoc> {
  const row = await getStored(ctx, resource, id)
  if (!row) throw synieError('not_found', `${catalogDocument(resource).label}不存在`)
  return row
}

export async function domainInternalForMutation(
  ctx: MutationCtx,
  resource: string,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await unsafeStoredForMutation(ctx, resource, id)
  return record(row.internalState ?? {}, '领域内部状态')
}

export async function patchDomainInternal(
  ctx: MutationCtx,
  resource: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await unsafeStoredForMutation(ctx, resource, id)
  await ctx.db.patch(row._id, {
    internalState: { ...record(row.internalState ?? {}, '领域内部状态'), ...patch },
    updatedAt: Date.now(),
  })
}

export function hydrateStored(row: RecordDoc): WireRecord {
  return hydrate(row)
}
