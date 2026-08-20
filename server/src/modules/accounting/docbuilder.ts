/**
 * 应收应付报表打印装配：当前查询当虚拟单据，不落库、不按记录 id。
 * 数字复用 EntryService.report / partyLedger，再套与页面相同的当前视图过滤。
 */
import {
  AR_AP_PARTY_TYPE_LABEL,
  AR_AP_SIDE_LABEL,
  netOfRow,
  visibleArApRows,
  type ArApLedgerSide,
} from '@synie/shared'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { DocBuilder } from '~/platform/printing/docbuilder.ts'
import {
  formatDate,
  formatDateTime,
  formatDecimal,
  formatText,
} from '~/platform/printing/format.ts'
import type { BuiltDoc, PrintDoc } from '~/platform/printing/types.ts'
import {
  AR_AP_PERMISSION_PREFIX,
  AR_AP_RESOURCE_NAME,
} from './meta.ts'
import type { ArApReportRow, EntryService } from './entry-service.ts'
import type { PartyLedger, PartyLedgerRow } from './party-ledger.ts'

export const AR_AP_READ_CODE = 'acc.gl_entry:read'

export interface ArApPrintContext {
  companyId: string
  asOf: string
  side: ArApLedgerSide
  search?: string
  partyTypes?: string[]
  sortColumn?: string
  sortDirection?: 'ascending' | 'descending'
  partyType?: string | null
  partyId?: string | null
  partyNil?: boolean
}

export function parseArApPrintContext(raw: Record<string, unknown>): ArApPrintContext {
  const companyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : ''
  const asOf = typeof raw.asOf === 'string' ? raw.asOf.trim() : ''
  const side = raw.side
  const fields: Record<string, string[]> = {}
  if (!companyId) fields.companyId = ['必填']
  else if (!/^[0-9a-f-]{36}$/i.test(companyId)) fields.companyId = ['必须是 UUID']
  if (!asOf) fields.asOf = ['必填']
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fields.asOf = ['必须是 YYYY-MM-DD 日期']
  if (side !== 'ar' && side !== 'ap') fields.side = ['必须是 ar 或 ap']
  const partyNil = raw.partyNil === true
  const partyType = typeof raw.partyType === 'string' ? raw.partyType.trim() : ''
  const partyId = typeof raw.partyId === 'string' ? raw.partyId.trim() : ''
  if (partyNil) {
    // 未指定对手：不要求 partyType/partyId
  } else if (partyType || partyId) {
    if (!partyType) fields.partyType = ['必填']
    if (!partyId) fields.partyId = ['必填']
    else if (!/^[0-9a-f-]{36}$/i.test(partyId)) fields.partyId = ['必须是 UUID']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('应收应付打印上下文不合法', fields)
  }
  const partyTypes = Array.isArray(raw.partyTypes)
    ? raw.partyTypes.filter((value): value is string => typeof value === 'string')
    : undefined
  const sortColumn = typeof raw.sortColumn === 'string' ? raw.sortColumn : undefined
  const sortDirection =
    raw.sortDirection === 'ascending' || raw.sortDirection === 'descending'
      ? raw.sortDirection
      : undefined
  const search = typeof raw.search === 'string' ? raw.search : undefined
  return {
    companyId,
    asOf,
    side: side as ArApLedgerSide,
    search,
    partyTypes,
    sortColumn,
    sortDirection,
    partyType: partyNil ? null : partyType || null,
    partyId: partyNil ? null : partyId || null,
    partyNil,
  }
}

export function createArApDocBuilder(
  db: DbHandle,
  entries: EntryService,
): DocBuilder {
  return {
    label: () => '应收应付报表',
    requiredCodes: [AR_AP_READ_CODE],
    async buildDocs() {
      throw ApiError.validation('应收应付报表不按单据 id 打印', {
        ids: ['请提供报表上下文'],
      })
    },
    async buildFromContext(permit: Permit, raw: Record<string, unknown>): Promise<BuiltDoc[]> {
      const ctx = parseArApPrintContext(raw)
      const company = await loadCompany(db, ctx.companyId)
      const exportedAt = formatDateTime(new Date())
      const perspective = AR_AP_SIDE_LABEL[ctx.side]
      const isDetail = ctx.partyNil === true || Boolean(ctx.partyId)
      if (isDetail) {
        const ledger = await entries.partyLedger(permit, {
          companyId: ctx.companyId,
          asOf: ctx.asOf,
          side: ctx.side,
          partyType: ctx.partyType,
          partyId: ctx.partyId,
          partyNil: ctx.partyNil === true,
        })
        const partyLabel = await resolvePartyLabel(db, ctx, ledger)
        return [
          {
            sheetName: sheetName(`${partyLabel}-${perspective}-${ctx.asOf}`),
            doc: detailDoc(company, ctx, exportedAt, partyLabel, ledger),
          },
        ]
      }
      const report = await entries.report(permit, {
        companyId: ctx.companyId,
        asOf: ctx.asOf,
      })
      const rows = visibleArApRows(report.rows, {
        side: ctx.side,
        search: ctx.search,
        partyTypes: ctx.partyTypes,
        sortColumn: ctx.sortColumn,
        sortDirection: ctx.sortDirection,
      })
      return [
        {
          sheetName: sheetName(`${company.name}-${perspective}-${ctx.asOf}`),
          doc: summaryDoc(company, ctx, exportedAt, rows),
        },
      ]
    },
  }
}

export function registerArApDocBuilder(
  printing: { registerDocBuilder: (resource: string, builder: DocBuilder) => void },
  db: DbHandle,
  entries: EntryService,
): void {
  printing.registerDocBuilder(AR_AP_PERMISSION_PREFIX, createArApDocBuilder(db, entries))
}

async function loadCompany(
  db: DbHandle,
  companyId: string,
): Promise<{ code: string; name: string; short_name: string }> {
  const row = await db
    .selectFrom('bas_company')
    .select(['code', 'name', 'short_name'])
    .where('id', '=', companyId)
    .executeTakeFirst()
  if (!row) {
    return { code: '', name: '', short_name: '' }
  }
  return row
}

async function resolvePartyLabel(
  db: DbHandle,
  ctx: ArApPrintContext,
  ledger: PartyLedger,
): Promise<string> {
  if (ctx.partyNil) return '未指定对手'
  const kind = (ctx.partyType ?? '').toLowerCase()
  const id = ctx.partyId
  if (!id) return '未指定对手'
  if (kind === 'customer') {
    const row = await db
      .selectFrom('sal_customers')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst()
    if (row) return row.name
  } else if (kind === 'supplier') {
    const row = await db
      .selectFrom('pur_supplier')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst()
    if (row) return row.name
  } else if (kind === 'company') {
    const row = await db
      .selectFrom('bas_company')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst()
    if (row) return row.name
  } else if (kind === 'employee') {
    const row = await db
      .selectFrom('hr_employees')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst()
    if (row) return row.name
  }
  void ledger
  return '未指定对手'
}

function summaryDoc(
  company: { code: string; name: string; short_name: string },
  ctx: ArApPrintContext,
  exportedAt: string,
  rows: ArApReportRow[],
): PrintDoc {
  return {
    fields: headFields(company, ctx, exportedAt, '', ''),
    loops: {
      rows: rows.map((row) => summaryRowFields(row, ctx.side)),
      ledger: [],
    },
  }
}

function detailDoc(
  company: { code: string; name: string; short_name: string },
  ctx: ArApPrintContext,
  exportedAt: string,
  partyLabel: string,
  ledger: PartyLedger,
): PrintDoc {
  const partyType = ctx.partyNil
    ? ''
    : AR_AP_PARTY_TYPE_LABEL[(ctx.partyType ?? '').toUpperCase()] ?? ctx.partyType ?? ''
  return {
    fields: headFields(company, ctx, exportedAt, partyLabel, partyType),
    loops: {
      rows: [],
      ledger: ledger.rows.map((row) => ledgerRowFields(row)),
    },
  }
}

function headFields(
  company: { code: string; name: string; short_name: string },
  ctx: ArApPrintContext,
  exportedAt: string,
  partyLabel: string,
  partyType: string,
): Record<string, string> {
  return {
    as_of: formatDate(ctx.asOf),
    perspective: AR_AP_SIDE_LABEL[ctx.side],
    exported_at: exportedAt,
    party_label: formatText(partyLabel),
    party_type: formatText(partyType),
    'company.code': formatText(company.code),
    'company.name': formatText(company.name),
    'company.short_name': formatText(company.short_name),
  }
}

function summaryRowFields(row: ArApReportRow, side: ArApLedgerSide): Record<string, string> {
  const partyType = row.partyType
    ? (AR_AP_PARTY_TYPE_LABEL[row.partyType] ?? row.partyType)
    : ''
  return {
    party_label: row.partyLabel,
    party_type: partyType,
    unbilled_receivable: formatDecimal(row.balances.unbilledReceivable),
    receivable: formatDecimal(row.balances.receivable),
    unbilled_payable: formatDecimal(row.balances.unbilledPayable),
    payable: formatDecimal(row.balances.payable),
    other_payable: formatDecimal(row.balances.otherPayable),
    net_receivable: formatDecimal(row.netReceivable),
    net_payable: formatDecimal(row.netPayable),
    net: formatDecimal(netOfRow(row, side)),
  }
}

function ledgerRowFields(row: PartyLedgerRow): Record<string, string> {
  return {
    posting_date: formatDate(row.postingDate),
    voucher_type_label: formatText(row.voucherTypeLabel),
    voucher_no: formatText(row.voucherNo),
    material_label: formatText(row.materialLabel),
    qty: formatDecimal(row.qty),
    unit_label: formatText(row.unitLabel),
    amount: formatDecimal(row.amount),
    unbilled_receivable: formatDecimal(row.balances.unbilledReceivable),
    receivable: formatDecimal(row.balances.receivable),
    unbilled_payable: formatDecimal(row.balances.unbilledPayable),
    payable: formatDecimal(row.balances.payable),
    other_payable: formatDecimal(row.balances.otherPayable),
    remarks: formatText(row.remarks),
  }
}

function sheetName(value: string): string {
  const cleaned = value.replace(/[:\\/?*[\]]/g, '-').trim()
  return cleaned.slice(0, 31) || '应收应付'
}

export { AR_AP_RESOURCE_NAME }
