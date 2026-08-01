import type { GenericMutationCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import { decimalToScaledInt64 } from '../../lib/decimal'
import { synieError } from '../../lib/errors'
import { catalogDocument, decimalScaleForField } from './policies'

type MutationCtx = GenericMutationCtx<DataModel>
type WireRecord = Record<string, unknown>

/**
 * Finite server-owned sort shapes used by Convex-mode screens. Each field is
 * materialised once in domainQueryRows and can be read in either direction;
 * the public adapter still resolves each direction to a distinct fixed profile.
 */
export const DOMAIN_SORT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  accBankImportItems: ['rowNo'],
  accBankTransactions: ['occurredAt'],
  accBillHoldings: ['dueDate'],
  accBillTransactions: ['occurredOn'],
  accExpenseReportItems: ['idx'],
  accGlEntries: ['postingDate', 'seq'],
  accGlJournalLines: ['idx'],
  hrAttendanceCorrections: ['insertedAt'],
  hrAttendanceDays: ['date'],
  hrAttendanceImports: ['insertedAt'],
  hrAttendancePunches: ['punchedAt'],
  hrEmployeeLoans: ['occurredOn'],
  hrPayrollPayments: ['paidOn'],
  invStockCountItems: ['insertedAt'],
  invStockCounts: ['postingDate'],
  invStockDocItems: ['idx'],
  invStockDocs: ['docDate'],
  invStockEntries: ['postingDate'],
  invStockTransferItems: ['idx'],
  invStockTransfers: ['docDate'],
  mfgBomRoutes: ['seq'],
  mfgDemandItems: ['idx'],
  mfgOutputItems: ['idx', 'outputDate'],
  mfgOutputs: ['outputDate'],
  mfgProcessTemplateItems: ['seq'],
  mfgWorkOrderByproducts: ['idx'],
  mfgWorkOrderComponents: ['idx'],
  mfgWorkOrderRoutes: ['seq'],
  mfgWorkOrders: ['needDate'],
  purOrderItems: ['idx', 'orderDate'],
  purOutsourcedIssueItems: ['idx', 'issueDate'],
  purOutsourcedIssues: ['issueDate'],
  purOutsourcedReceiptItemByproducts: ['idx'],
  purOutsourcedReceiptItemMaterials: ['idx'],
  purOutsourcedReceiptItems: ['idx', 'receiptDate'],
  purOutsourcedReceipts: ['receiptDate'],
  purQuotationItems: ['idx', 'quotationDate'],
  purReceiptItems: ['idx', 'receiptDate'],
  purReceipts: ['receiptDate'],
  purReconciliationItems: ['idx', 'receiptDate'],
  purReconciliations: ['reconciliationNo'],
  salDeliveryItems: ['idx', 'deliveryDate'],
  salDeliveries: ['deliveryDate'],
  salOrderItems: ['idx', 'orderDate'],
  salQuotationItems: ['idx', 'quotationDate'],
  salReconciliationItems: ['idx', 'deliveryDate'],
  salReconciliations: ['reconciliationNo'],
})

/** Finite non-scope equalities needed by current grids. */
export const DOMAIN_EQUALITY_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  hrPayrolls: ['month'],
  mfgBoms: ['materialId'],
})

export function domainSortFields(resource: string): readonly string[] {
  return DOMAIN_SORT_FIELDS[resource] ?? []
}

export function domainEqualityFields(resource: string): readonly string[] {
  return DOMAIN_EQUALITY_FIELDS[resource] ?? []
}

function integerKey(value: number | bigint): string {
  const numeric = typeof value === 'bigint' ? value : BigInt(value)
  const shifted = numeric + (1n << 127n)
  if (shifted < 0n || shifted >= (1n << 128n)) throw synieError('validation', '排序整数超出范围')
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

function equalityValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

/**
 * Rebuilds the bounded query projections for one closure record. The row itself
 * carries company/status/parent facts, so five indexes reuse one write instead
 * of duplicating one row per scope.
 */
export async function replaceDomainQueryRows(
  ctx: MutationCtx,
  resource: string,
  recordId: string,
  wire: WireRecord | null,
  scope?: { companyId?: string | null; parentId?: string | null; status?: string | null },
): Promise<void> {
  const existing = await ctx.db.query('domainQueryRows').withIndex('by_record', (q) =>
    q.eq('resource', resource).eq('recordId', recordId),
  ).collect()
  for (const row of existing) await ctx.db.delete(row._id)
  if (!wire) return

  const companyId = scope?.companyId ?? (typeof wire.companyId === 'string' ? wire.companyId : null)
  const parentId = scope?.parentId ?? null
  const status = scope?.status ?? (typeof wire.status === 'string' ? wire.status : null)
  for (const field of domainSortFields(resource)) {
    await ctx.db.insert('domainQueryRows', {
      resource,
      profile: `sort:${field}`,
      recordId,
      companyId,
      parentId,
      status,
      equalityField: '',
      equalityValue: '',
      sortValue: valueKey(resource, field, wire[field]),
    })
  }
  for (const field of domainEqualityFields(resource)) {
    const value = equalityValue(wire[field])
    if (value === null) continue
    await ctx.db.insert('domainQueryRows', {
      resource,
      profile: 'sort:default',
      recordId,
      companyId,
      parentId,
      status,
      equalityField: field,
      equalityValue: value,
      sortValue: valueKey(resource, catalogDocument(resource).lookup.labelField, wire[catalogDocument(resource).lookup.labelField]),
    })
  }
}
