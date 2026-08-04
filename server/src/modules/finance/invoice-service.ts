/**
 * 增值税发票：销项/进项/费用报销票生命周期。
 * 审核/作废/红冲走总账过账骨架；对账结单/重开经 after* 钩子（reconciliations 接缝）。
 */
import { decimal, isDecimalString, toDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import {
  canAccessCompany,
  hasPermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import type { FileService } from '~/platform/files/service.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { ReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import type { TradingSide } from '~/modules/trading/common.ts'
import { auditGlDocInTx, voidGlDocInTx } from '~/platform/posting/skeleton.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { vatInvoiceResourceMeta } from './meta.ts'
import { recognizeVatInvoice, type OcrDeps, type OcrPrefill } from './ocr.ts'

export type InvoiceStatus = 'DRAFT' | 'AUDITED' | 'VOIDED' | 'REVERSED'
export type InvoiceDirection = 'INBOUND' | 'OUTBOUND'
export type InvoicePartyType = 'SUPPLIER' | 'CUSTOMER' | 'COMPANY' | 'EMPLOYEE'

export interface VatInvoice {
  id: string
  docNo: string | null
  direction: InvoiceDirection
  invoiceDate: string | null
  postingDate: string | null
  partyType: InvoicePartyType
  partyId: string
  invoiceKind: string
  invoiceCode: string
  invoiceNo: string | null
  sellerName: string | null
  sellerTaxNo: string | null
  sellerAddressPhone: string | null
  sellerBankAccount: string | null
  buyerName: string | null
  buyerTaxNo: string | null
  buyerAddressPhone: string | null
  buyerBankAccount: string | null
  items: Record<string, unknown>[]
  netTotal: string | null
  taxTotal: string | null
  grossTotal: string | null
  issuer: string | null
  reviewer: string | null
  payee: string | null
  remarks: string | null
  redInvoiceNo: string | null
  status: InvoiceStatus
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  partyAccountId: string | null
  amountAccountId: string | null
  taxAccountId: string | null
  mirrorInvoiceId: string | null
  createdById: string | null
  auditedById: string | null
  salReconciliationId: string | null
  purReconciliationId: string | null
}

export interface VatInvoiceInput {
  companyId: string
  docNo?: string | null
  direction: string
  invoiceDate?: string | null
  partyType: string
  partyId: string
  invoiceKind: string
  invoiceCode?: string | null
  invoiceNo?: string | null
  sellerName?: string | null
  sellerTaxNo?: string | null
  sellerAddressPhone?: string | null
  sellerBankAccount?: string | null
  buyerName?: string | null
  buyerTaxNo?: string | null
  buyerAddressPhone?: string | null
  buyerBankAccount?: string | null
  items?: Record<string, unknown>[] | null
  netTotal?: string | null
  taxTotal?: string | null
  grossTotal?: string | null
  issuer?: string | null
  reviewer?: string | null
  payee?: string | null
  remarks?: string | null
  partyAccountId?: string | null
  amountAccountId?: string | null
  taxAccountId?: string | null
  mirrorInvoiceId?: string | null
  salReconciliationId?: string | null
  purReconciliationId?: string | null
}

/** 更新：*Present 标记 JSON null 与缺省区分（对齐 optional 三态） */
export interface VatInvoiceUpdateInput {
  docNo?: string | null
  docNoPresent?: boolean
  direction?: string
  invoiceDate?: string | null
  invoiceDatePresent?: boolean
  partyType?: string
  partyId?: string
  invoiceKind?: string
  invoiceCode?: string | null
  invoiceCodePresent?: boolean
  invoiceNo?: string | null
  invoiceNoPresent?: boolean
  sellerName?: string | null
  sellerNamePresent?: boolean
  sellerTaxNo?: string | null
  sellerTaxNoPresent?: boolean
  sellerAddressPhone?: string | null
  sellerAddressPhonePresent?: boolean
  sellerBankAccount?: string | null
  sellerBankAccountPresent?: boolean
  buyerName?: string | null
  buyerNamePresent?: boolean
  buyerTaxNo?: string | null
  buyerTaxNoPresent?: boolean
  buyerAddressPhone?: string | null
  buyerAddressPhonePresent?: boolean
  buyerBankAccount?: string | null
  buyerBankAccountPresent?: boolean
  items?: Record<string, unknown>[] | null
  itemsPresent?: boolean
  netTotal?: string | null
  netTotalPresent?: boolean
  taxTotal?: string | null
  taxTotalPresent?: boolean
  grossTotal?: string | null
  grossTotalPresent?: boolean
  issuer?: string | null
  issuerPresent?: boolean
  reviewer?: string | null
  reviewerPresent?: boolean
  payee?: string | null
  payeePresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
  partyAccountId?: string | null
  partyAccountIdPresent?: boolean
  amountAccountId?: string | null
  amountAccountIdPresent?: boolean
  taxAccountId?: string | null
  taxAccountIdPresent?: boolean
  mirrorInvoiceId?: string | null
  mirrorInvoiceIdPresent?: boolean
  salReconciliationId?: string | null
  salReconciliationIdPresent?: boolean
  purReconciliationId?: string | null
  purReconciliationIdPresent?: boolean
}

const VOUCHER_TYPE = 'acc.vat_invoice'
const PERM = 'acc.vat_invoice'

const KINDS = new Set([
  'SPECIAL',
  'NORMAL',
  'ELECTRONIC_SPECIAL',
  'ELECTRONIC_NORMAL',
  'DIGITAL_SPECIAL',
  'DIGITAL_NORMAL',
])

const INVOICE_AUDIT = auditFieldsOf(vatInvoiceResourceMeta())

const WRITE_MAPPINGS = [
  { code: '23505', message: '同一公司内发票号码或内部编号冲突' },
  { code: '23503', message: '增值税发票引用不存在' },
] as const

const INVOICE_SELECT = sql`
SELECT id, doc_no, direction, invoice_date, posting_date, party_type, party_id,
  invoice_kind, invoice_code, invoice_no, seller_name, seller_tax_no,
  seller_address_phone, seller_bank_account, buyer_name, buyer_tax_no,
  buyer_address_phone, buyer_bank_account, array_to_json(items)::text AS items_json,
  net_total, tax_total, gross_total, issuer, reviewer, payee, remarks,
  red_invoice_no, status, audited_at, inserted_at, updated_at, company_id,
  party_account_id, amount_account_id, tax_account_id, mirror_invoice_id,
  created_by_id, audited_by_id, sal_reconciliation_id, pur_reconciliation_id`

const INVOICE_SOURCE = sql` FROM acc_vat_invoice`

export type VatInvoiceService = ReturnType<typeof createVatInvoiceService>

export interface VatInvoiceServiceDeps {
  gl: GlEngine
  reconciliations: Pick<
    ReconciliationService,
    'closeFromInvoice' | 'reopenFromInvoice' | 'existsForInvoice' | 'loadForInvoiceAudit'
  >
  files?: Pick<FileService, 'readStoredFile'> | null
  ocr?: OcrDeps
}

export function createVatInvoiceService(
  db: Kysely<Database>,
  numbering: NumberingService,
  deps: VatInvoiceServiceDeps,
) {
  const gl = deps.gl
  const reconciliations = deps.reconciliations
  const files = deps.files ?? null

  async function list(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: VatInvoice[] }> {
    requireAction(actor, 'read')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] }
    return listFromSource({
      db,
      resource: vatInvoiceResourceMeta(),
      source: INVOICE_SOURCE,
      select: INVOICE_SELECT,
      defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
      query,
      extraWhere: scope.where,
      mapRow: mapInvoiceRow,
    })
  }

  async function get(actor: Actor, id: string): Promise<VatInvoice> {
    requireAction(actor, 'read')
    const item = await loadInvoice(db, id)
    if (!canAccessCompany(actor, item.companyId)) throw notFound()
    return item
  }

  async function create(actor: Actor, input: VatInvoiceInput): Promise<VatInvoice> {
    requireAction(actor, 'create')
    if (!canAccessCompany(actor, input.companyId)) throw notFound()
    const normalized = normalizeInput(input)
    return withTx(db, async (trx) => {
      await validateReferences(trx, reconciliations, normalized, null, false)
      let docNo = (normalized.docNo ?? '').trim()
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: 'acc.vat_invoice',
          values: {
            company_id: normalized.companyId,
            posting_date: new Date().toISOString(),
          },
        })
      }
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO acc_vat_invoice(
            doc_no, direction, invoice_date, party_type, party_id, invoice_kind,
            invoice_code, invoice_no, seller_name, seller_tax_no, seller_address_phone,
            seller_bank_account, buyer_name, buyer_tax_no, buyer_address_phone,
            buyer_bank_account, items, net_total, tax_total, gross_total, issuer,
            reviewer, payee, remarks, company_id, party_account_id, amount_account_id,
            tax_account_id, mirror_invoice_id, created_by_id,
            sal_reconciliation_id, pur_reconciliation_id
          ) VALUES (
            ${docNo}, ${lower(normalized.direction)}, ${normalized.invoiceDate}::date,
            ${lower(normalized.partyType)}, ${normalized.partyId}::uuid,
            ${lower(normalized.invoiceKind)}, ${normalized.invoiceCode},
            ${normalized.invoiceNo}, ${normalized.sellerName}, ${normalized.sellerTaxNo},
            ${normalized.sellerAddressPhone}, ${normalized.sellerBankAccount},
            ${normalized.buyerName}, ${normalized.buyerTaxNo},
            ${normalized.buyerAddressPhone}, ${normalized.buyerBankAccount},
            ${itemsArraySql(normalized.items)},
            ${normalized.netTotal}, ${normalized.taxTotal}, ${normalized.grossTotal},
            ${normalized.issuer}, ${normalized.reviewer}, ${normalized.payee},
            ${normalized.remarks}, ${normalized.companyId}::uuid,
            ${normalized.partyAccountId}::uuid, ${normalized.amountAccountId}::uuid,
            ${normalized.taxAccountId}::uuid, ${normalized.mirrorInvoiceId}::uuid,
            ${actorUserId(actor)}::uuid,
            ${normalized.salReconciliationId}::uuid,
            ${normalized.purReconciliationId}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = ins.rows[0]!.id
        const result = await loadInvoice(trx, id)
        await writeAudit(trx, actor, {
          resource: 'acc_vat_invoice',
          recordId: id,
          recordLabel: invoiceLabel(result),
          companyId: result.companyId,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(invoiceSnap(result), INVOICE_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建增值税发票失败', WRITE_MAPPINGS)
      }
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: VatInvoiceUpdateInput,
  ): Promise<VatInvoice> {
    requireAction(actor, 'update')
    return withTx(db, async (trx) => {
      const before = await lockInvoice(trx, actor, id)
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿发票可修改或删除')
      }
      const merged = normalizeInput(overlay(before, input))
      await validateReferences(trx, reconciliations, merged, id, false)
      try {
        await sql`
          UPDATE acc_vat_invoice SET
            doc_no=${merged.docNo}, direction=${lower(merged.direction)},
            invoice_date=${merged.invoiceDate}::date,
            party_type=${lower(merged.partyType)}, party_id=${merged.partyId}::uuid,
            invoice_kind=${lower(merged.invoiceKind)}, invoice_code=${merged.invoiceCode},
            invoice_no=${merged.invoiceNo}, seller_name=${merged.sellerName},
            seller_tax_no=${merged.sellerTaxNo},
            seller_address_phone=${merged.sellerAddressPhone},
            seller_bank_account=${merged.sellerBankAccount},
            buyer_name=${merged.buyerName}, buyer_tax_no=${merged.buyerTaxNo},
            buyer_address_phone=${merged.buyerAddressPhone},
            buyer_bank_account=${merged.buyerBankAccount},
            items=${itemsArraySql(merged.items)},
            net_total=${merged.netTotal}, tax_total=${merged.taxTotal},
            gross_total=${merged.grossTotal}, issuer=${merged.issuer},
            reviewer=${merged.reviewer}, payee=${merged.payee}, remarks=${merged.remarks},
            party_account_id=${merged.partyAccountId}::uuid,
            amount_account_id=${merged.amountAccountId}::uuid,
            tax_account_id=${merged.taxAccountId}::uuid,
            mirror_invoice_id=${merged.mirrorInvoiceId}::uuid,
            sal_reconciliation_id=${merged.salReconciliationId}::uuid,
            pur_reconciliation_id=${merged.purReconciliationId}::uuid,
            updated_at=(now() AT TIME ZONE 'utc')
          WHERE id=${id}::uuid
        `.execute(trx)
        const result = await loadInvoice(trx, id)
        await writeAudit(trx, actor, {
          resource: 'acc_vat_invoice',
          recordId: id,
          recordLabel: invoiceLabel(result),
          companyId: result.companyId,
          actionType: 'update',
          actionName: 'update',
          changes: auditDiff(invoiceSnap(before), invoiceSnap(result), INVOICE_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新增值税发票失败', WRITE_MAPPINGS)
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requireAction(actor, 'delete')
    await withTx(db, async (trx) => {
      const before = await lockInvoice(trx, actor, id)
      if (before.status !== 'DRAFT') {
        throw new ApiError('conflict', '仅草稿发票可修改或删除')
      }
      try {
        await sql`DELETE FROM acc_vat_invoice WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_vat_invoice',
          recordId: id,
          recordLabel: invoiceLabel(before),
          companyId: before.companyId,
          actionType: 'delete',
          actionName: 'delete',
          changes: auditDestroyed(invoiceSnap(before), INVOICE_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除增值税发票失败', WRITE_MAPPINGS)
      }
    })
  }

  async function audit(
    actor: Actor,
    id: string,
    postingDate: string,
  ): Promise<VatInvoice> {
    requireAction(actor, 'audit')
    const posting = requireDate(postingDate, 'postingDate')
    return withTx(db, async (trx) => {
      let reconSide: TradingSide | null = null
      let reconId: string | null = null
      return auditGlDocInTx(trx, actor, gl, {
        voucherType: VOUCHER_TYPE,
        headTable: 'acc_vat_invoice',
        conflictMessage: '发票已被并发处理',
        lockDraft: async (t) => {
          const before = await lockInvoice(t, actor, id)
          if (before.status !== 'DRAFT') {
            throw new ApiError('conflict', '仅草稿发票可审核')
          }
          return before
        },
        collect: async (t, before) => {
          const input = toInput(before)
          await validateReferences(t, reconciliations, input, id, true)
          const entries = invoiceGLEntries(before)
          const { reconEntries, side, reconciliationId } = await reconciliationGLEntries(
            t,
            reconciliations,
            before,
          )
          entries.push(...reconEntries)
          reconSide = side
          reconId = reconciliationId
          return { entries, postingDate: posting }
        },
        afterAudit: async (t) => {
          if (reconId && reconSide) {
            await reconciliations.closeFromInvoice(t, actor, reconSide, reconId)
          }
        },
        voucherOf: (h) => ({ id: h.id, no: invoiceLabel(h), companyId: h.companyId }),
        reload: (t, headId) => loadInvoice(t, headId),
        snapshot: invoiceSnap,
        auditFields: INVOICE_AUDIT,
      })
    })
  }

    async function voidInvoice(actor: Actor, id: string): Promise<VatInvoice> {
    return endInvoice(actor, id, false, {})
  }

  async function reverse(
    actor: Actor,
    id: string,
    input: { postingDate: string; redInvoiceNo?: string | null },
  ): Promise<VatInvoice> {
    return endInvoice(actor, id, true, input)
  }

  async function endInvoice(
    actor: Actor,
    id: string,
    reverseMode: boolean,
    input: { postingDate?: string; redInvoiceNo?: string | null },
  ): Promise<VatInvoice> {
    const action = reverseMode ? 'reverse' : 'void'
    requireAction(actor, action)
    let posting = ''
    if (reverseMode) {
      posting = requireDate(input.postingDate ?? '', 'postingDate')
    }
    return withTx(db, async (trx) =>
      voidGlDocInTx(trx, actor, gl, {
        voucherType: VOUCHER_TYPE,
        headTable: 'acc_vat_invoice',
        actionName: action,
        voidStatus: reverseMode ? 'reversed' : 'voided',
        lockAudited: async (t) => {
          const before = await lockInvoice(t, actor, id)
          if (before.status !== 'AUDITED') {
            throw new ApiError('conflict', '仅已审核发票可作废或红冲')
          }
          const referenced = await sql<{ e: boolean }>`
            SELECT EXISTS(
              SELECT 1 FROM acc_expense_report_item i
              JOIN acc_expense_report r ON r.id=i.report_id
              WHERE i.invoice_id=${id}::uuid AND r.status<>'voided'
            ) AS e
          `.execute(t)
          if (referenced.rows[0]?.e) {
            throw new ApiError(
              'conflict',
              '发票已被报销单引用,请先在报销单上移除该行或作废报销单',
            )
          }
          return before
        },
        resolveGlEnd: async () =>
          reverseMode
            ? { mode: 'reverse' as const, reversePostingDate: posting }
            : { mode: 'cancel' as const },
        flipToEnded: async (t, before, nextStatus) => {
          const redNo = reverseMode
            ? (input.redInvoiceNo ?? null)
            : before.redInvoiceNo
          await sql`
            UPDATE acc_vat_invoice SET status=${nextStatus},
              red_invoice_no=${redNo},
              sal_reconciliation_id=NULL, pur_reconciliation_id=NULL,
              updated_at=(now() AT TIME ZONE 'utc')
            WHERE id=${id}::uuid
          `.execute(t)
        },
        afterVoid: async (t, before) => {
          if (before.salReconciliationId) {
            await reconciliations.reopenFromInvoice(
              t,
              actor,
              'sales',
              before.salReconciliationId,
            )
          }
          if (before.purReconciliationId) {
            await reconciliations.reopenFromInvoice(
              t,
              actor,
              'purchase',
              before.purReconciliationId,
            )
          }
        },
        voucherOf: (h) => ({ id: h.id, no: invoiceLabel(h), companyId: h.companyId }),
        reload: (t, headId) => loadInvoice(t, headId),
        snapshot: invoiceSnap,
        auditFields: INVOICE_AUDIT,
      }),
    )
  }

  async function ocr(actor: Actor, fileId: string): Promise<OcrPrefill> {
    requireAction(actor, 'create')
    if (!files) {
      throw new ApiError('internal', 'OCR 服务未配置')
    }
    await requireAccessibleFile(db, actor, fileId)
    const { file, content } = await files.readStoredFile(fileId)
    return recognizeVatInvoice(db, file, content, deps.ocr)
  }

  return { list, get, create, update, remove, audit, void: voidInvoice, reverse, ocr }
}

// ---- load / map ----

async function loadInvoice(db: DbHandle, id: string): Promise<VatInvoice> {
  const rows = await sql<Record<string, unknown>>`
    ${INVOICE_SELECT} FROM acc_vat_invoice WHERE id=${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) throw notFound()
  return mapInvoiceRow(rows.rows[0]!)
}

async function lockInvoice(
  db: DbHandle,
  actor: Actor,
  id: string,
): Promise<VatInvoice> {
  const rows = await sql<Record<string, unknown>>`
    ${INVOICE_SELECT} FROM acc_vat_invoice WHERE id=${id}::uuid FOR UPDATE
  `.execute(db)
  if (rows.rows.length === 0) throw notFound()
  const item = mapInvoiceRow(rows.rows[0]!)
  if (!canAccessCompany(actor, item.companyId)) throw notFound()
  return item
}

function mapInvoiceRow(row: Record<string, unknown>): VatInvoice {
  let items: Record<string, unknown>[] = []
  const rawItems = row.items_json ?? row.items
  if (typeof rawItems === 'string') {
    try {
      const parsed = JSON.parse(rawItems) as unknown
      items = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
    } catch {
      items = []
    }
  } else if (Array.isArray(rawItems)) {
    items = rawItems as Record<string, unknown>[]
  }
  return {
    id: String(row.id),
    docNo: optStr(row.doc_no),
    direction: upper(String(row.direction)) as InvoiceDirection,
    invoiceDate: dateOnly(row.invoice_date),
    postingDate: dateOnly(row.posting_date),
    partyType: upper(String(row.party_type)) as InvoicePartyType,
    partyId: String(row.party_id),
    invoiceKind: upper(String(row.invoice_kind)),
    invoiceCode: row.invoice_code == null ? '' : String(row.invoice_code),
    invoiceNo: optStr(row.invoice_no),
    sellerName: optStr(row.seller_name),
    sellerTaxNo: optStr(row.seller_tax_no),
    sellerAddressPhone: optStr(row.seller_address_phone),
    sellerBankAccount: optStr(row.seller_bank_account),
    buyerName: optStr(row.buyer_name),
    buyerTaxNo: optStr(row.buyer_tax_no),
    buyerAddressPhone: optStr(row.buyer_address_phone),
    buyerBankAccount: optStr(row.buyer_bank_account),
    items,
    netTotal: wireDec(row.net_total),
    taxTotal: wireDec(row.tax_total),
    grossTotal: wireDec(row.gross_total),
    issuer: optStr(row.issuer),
    reviewer: optStr(row.reviewer),
    payee: optStr(row.payee),
    remarks: optStr(row.remarks),
    redInvoiceNo: optStr(row.red_invoice_no),
    status: upper(String(row.status)) as InvoiceStatus,
    auditedAt: datetimeIso(row.audited_at),
    insertedAt: datetimeIso(row.inserted_at)!,
    updatedAt: datetimeIso(row.updated_at)!,
    companyId: String(row.company_id),
    partyAccountId: optId(row.party_account_id),
    amountAccountId: optId(row.amount_account_id),
    taxAccountId: optId(row.tax_account_id),
    mirrorInvoiceId: optId(row.mirror_invoice_id),
    createdById: optId(row.created_by_id),
    auditedById: optId(row.audited_by_id),
    salReconciliationId: optId(row.sal_reconciliation_id),
    purReconciliationId: optId(row.pur_reconciliation_id),
  }
}

// ---- validation / normalize ----

interface NormalizedInput {
  companyId: string
  docNo: string | null
  direction: InvoiceDirection
  invoiceDate: string | null
  partyType: InvoicePartyType
  partyId: string
  invoiceKind: string
  invoiceCode: string
  invoiceNo: string | null
  sellerName: string | null
  sellerTaxNo: string | null
  sellerAddressPhone: string | null
  sellerBankAccount: string | null
  buyerName: string | null
  buyerTaxNo: string | null
  buyerAddressPhone: string | null
  buyerBankAccount: string | null
  items: Record<string, unknown>[]
  netTotal: string | null
  taxTotal: string | null
  grossTotal: string | null
  issuer: string | null
  reviewer: string | null
  payee: string | null
  remarks: string | null
  partyAccountId: string | null
  amountAccountId: string | null
  taxAccountId: string | null
  mirrorInvoiceId: string | null
  salReconciliationId: string | null
  purReconciliationId: string | null
}

function normalizeInput(input: VatInvoiceInput): NormalizedInput {
  const direction = upper(input.direction) as InvoiceDirection
  const partyType = upper(input.partyType) as InvoicePartyType
  const invoiceKind = upper(input.invoiceKind)
  const fields: Record<string, string[]> = {}
  if (!input.companyId) fields.companyId = ['必填']
  if (direction !== 'INBOUND' && direction !== 'OUTBOUND') {
    fields.direction = ['不合法']
  }
  if (!input.partyId) fields.partyId = ['必填']
  if (!['SUPPLIER', 'CUSTOMER', 'COMPANY', 'EMPLOYEE'].includes(partyType)) {
    fields.partyType = ['不合法']
  }
  if (partyType === 'COMPANY' && input.partyId === input.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (partyType === 'EMPLOYEE' && direction !== 'INBOUND') {
    fields.direction = ['员工对手的发票必须为开入方向']
  }
  if (!KINDS.has(invoiceKind)) fields.invoiceKind = ['不合法']
  const sal = input.salReconciliationId ?? null
  const pur = input.purReconciliationId ?? null
  if (partyType === 'EMPLOYEE') {
    if (sal || pur) fields.reconciliation = ['费用报销发票不关联对账单']
  } else if (direction === 'OUTBOUND') {
    if (!sal || pur) fields.salReconciliationId = ['开出发票必须且仅关联销售对账单']
  } else if (direction === 'INBOUND') {
    if (!pur || sal) fields.purReconciliationId = ['开入发票必须且仅关联采购对账单']
  }
  const items = Array.isArray(input.items) ? input.items : []
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('增值税发票参数不合法', fields)
  }
  return {
    companyId: input.companyId,
    docNo: emptyToNull(input.docNo),
    direction,
    invoiceDate: emptyToNull(input.invoiceDate),
    partyType,
    partyId: input.partyId,
    invoiceKind,
    invoiceCode: (input.invoiceCode ?? '').trim(),
    invoiceNo: emptyToNull(input.invoiceNo),
    sellerName: emptyToNull(input.sellerName),
    sellerTaxNo: emptyToNull(input.sellerTaxNo),
    sellerAddressPhone: emptyToNull(input.sellerAddressPhone),
    sellerBankAccount: emptyToNull(input.sellerBankAccount),
    buyerName: emptyToNull(input.buyerName),
    buyerTaxNo: emptyToNull(input.buyerTaxNo),
    buyerAddressPhone: emptyToNull(input.buyerAddressPhone),
    buyerBankAccount: emptyToNull(input.buyerBankAccount),
    items,
    netTotal: emptyToNull(input.netTotal),
    taxTotal: emptyToNull(input.taxTotal),
    grossTotal: emptyToNull(input.grossTotal),
    issuer: emptyToNull(input.issuer),
    reviewer: emptyToNull(input.reviewer),
    payee: emptyToNull(input.payee),
    remarks: emptyToNull(input.remarks),
    partyAccountId: input.partyAccountId ?? null,
    amountAccountId: input.amountAccountId ?? null,
    taxAccountId: input.taxAccountId ?? null,
    mirrorInvoiceId: input.mirrorInvoiceId ?? null,
    salReconciliationId: sal,
    purReconciliationId: pur,
  }
}

function overlay(before: VatInvoice, update: VatInvoiceUpdateInput): VatInvoiceInput {
  const pick = <T>(
    present: boolean | undefined,
    value: T | null | undefined,
    fallback: T | null,
  ): T | null => (present ? (value ?? null) : fallback)

  return {
    companyId: before.companyId,
    docNo: pick(update.docNoPresent, update.docNo, before.docNo),
    direction: update.direction ?? before.direction,
    invoiceDate: pick(update.invoiceDatePresent, update.invoiceDate, before.invoiceDate),
    partyType: update.partyType ?? before.partyType,
    partyId: update.partyId ?? before.partyId,
    invoiceKind: update.invoiceKind ?? before.invoiceKind,
    invoiceCode: update.invoiceCodePresent
      ? (update.invoiceCode ?? '')
      : before.invoiceCode,
    invoiceNo: pick(update.invoiceNoPresent, update.invoiceNo, before.invoiceNo),
    sellerName: pick(update.sellerNamePresent, update.sellerName, before.sellerName),
    sellerTaxNo: pick(update.sellerTaxNoPresent, update.sellerTaxNo, before.sellerTaxNo),
    sellerAddressPhone: pick(
      update.sellerAddressPhonePresent,
      update.sellerAddressPhone,
      before.sellerAddressPhone,
    ),
    sellerBankAccount: pick(
      update.sellerBankAccountPresent,
      update.sellerBankAccount,
      before.sellerBankAccount,
    ),
    buyerName: pick(update.buyerNamePresent, update.buyerName, before.buyerName),
    buyerTaxNo: pick(update.buyerTaxNoPresent, update.buyerTaxNo, before.buyerTaxNo),
    buyerAddressPhone: pick(
      update.buyerAddressPhonePresent,
      update.buyerAddressPhone,
      before.buyerAddressPhone,
    ),
    buyerBankAccount: pick(
      update.buyerBankAccountPresent,
      update.buyerBankAccount,
      before.buyerBankAccount,
    ),
    items: update.itemsPresent ? (update.items ?? []) : before.items,
    netTotal: pick(update.netTotalPresent, update.netTotal, before.netTotal),
    taxTotal: pick(update.taxTotalPresent, update.taxTotal, before.taxTotal),
    grossTotal: pick(update.grossTotalPresent, update.grossTotal, before.grossTotal),
    issuer: pick(update.issuerPresent, update.issuer, before.issuer),
    reviewer: pick(update.reviewerPresent, update.reviewer, before.reviewer),
    payee: pick(update.payeePresent, update.payee, before.payee),
    remarks: pick(update.remarksPresent, update.remarks, before.remarks),
    partyAccountId: pick(
      update.partyAccountIdPresent,
      update.partyAccountId,
      before.partyAccountId,
    ),
    amountAccountId: pick(
      update.amountAccountIdPresent,
      update.amountAccountId,
      before.amountAccountId,
    ),
    taxAccountId: pick(
      update.taxAccountIdPresent,
      update.taxAccountId,
      before.taxAccountId,
    ),
    mirrorInvoiceId: pick(
      update.mirrorInvoiceIdPresent,
      update.mirrorInvoiceId,
      before.mirrorInvoiceId,
    ),
    salReconciliationId: pick(
      update.salReconciliationIdPresent,
      update.salReconciliationId,
      before.salReconciliationId,
    ),
    purReconciliationId: pick(
      update.purReconciliationIdPresent,
      update.purReconciliationId,
      before.purReconciliationId,
    ),
  }
}

function toInput(value: VatInvoice): NormalizedInput {
  return normalizeInput({
    companyId: value.companyId,
    docNo: value.docNo,
    direction: value.direction,
    invoiceDate: value.invoiceDate,
    partyType: value.partyType,
    partyId: value.partyId,
    invoiceKind: value.invoiceKind,
    invoiceCode: value.invoiceCode,
    invoiceNo: value.invoiceNo,
    sellerName: value.sellerName,
    sellerTaxNo: value.sellerTaxNo,
    sellerAddressPhone: value.sellerAddressPhone,
    sellerBankAccount: value.sellerBankAccount,
    buyerName: value.buyerName,
    buyerTaxNo: value.buyerTaxNo,
    buyerAddressPhone: value.buyerAddressPhone,
    buyerBankAccount: value.buyerBankAccount,
    items: value.items,
    netTotal: value.netTotal,
    taxTotal: value.taxTotal,
    grossTotal: value.grossTotal,
    issuer: value.issuer,
    reviewer: value.reviewer,
    payee: value.payee,
    remarks: value.remarks,
    partyAccountId: value.partyAccountId,
    amountAccountId: value.amountAccountId,
    taxAccountId: value.taxAccountId,
    mirrorInvoiceId: value.mirrorInvoiceId,
    salReconciliationId: value.salReconciliationId,
    purReconciliationId: value.purReconciliationId,
  })
}

type ReconSeam = Pick<
  ReconciliationService,
  'closeFromInvoice' | 'reopenFromInvoice' | 'existsForInvoice' | 'loadForInvoiceAudit'
>

async function validateReferences(
  db: DbHandle,
  reconciliations: ReconSeam,
  input: NormalizedInput,
  ownId: string | null,
  auditMode: boolean,
): Promise<void> {
  const partyOk = await sql<{ e: boolean }>`
    SELECT CASE ${lower(input.partyType)}::text
      WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=${input.partyId}::uuid)
      WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=${input.partyId}::uuid)
      WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=${input.partyId}::uuid)
      WHEN 'employee' THEN EXISTS(SELECT 1 FROM hr_employees WHERE id=${input.partyId}::uuid)
      ELSE false END AS e
  `.execute(db)
  if (!partyOk.rows[0]?.e) {
    throw ApiError.validation('增值税发票参数不合法', { partyId: ['对手不存在'] })
  }
  if (input.mirrorInvoiceId) {
    const mir = await sql<{ e: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM acc_vat_invoice
        WHERE id=${input.mirrorInvoiceId}::uuid
          AND (${ownId}::uuid IS NULL OR id<>${ownId}::uuid)
      ) AS e
    `.execute(db)
    if (!mir.rows[0]?.e) {
      throw ApiError.validation('增值税发票参数不合法', {
        mirrorInvoiceId: ['对向发票不存在'],
      })
    }
  }
  if (!auditMode) {
    if (input.salReconciliationId) {
      const exists = await reconciliations.existsForInvoice(
        db,
        'sales',
        input.salReconciliationId,
      )
      if (!exists) {
        throw ApiError.validation('增值税发票参数不合法', {
          salReconciliationId: ['关联销售对账单不存在'],
        })
      }
    }
    if (input.purReconciliationId) {
      const exists = await reconciliations.existsForInvoice(
        db,
        'purchase',
        input.purReconciliationId,
      )
      if (!exists) {
        throw ApiError.validation('增值税发票参数不合法', {
          purReconciliationId: ['关联采购对账单不存在'],
        })
      }
    }
    return
  }
  if (!input.invoiceDate || !input.invoiceNo || !input.invoiceNo.trim()) {
    throw ApiError.validation('发票审核条件不完整', {
      invoice: ['开票日期与发票号码必填'],
    })
  }
  const net = parseOptionalDecimal(input.netTotal, 'netTotal', false, true)
  const tax = parseOptionalDecimal(input.taxTotal, 'taxTotal', false, true)
  const gross = parseOptionalDecimal(input.grossTotal, 'grossTotal', true, false)
  if (!net) {
    throw ApiError.validation('发票审核条件不完整', {
      netTotal: ['必填且不能为负数'],
    })
  }
  if (!tax) {
    throw ApiError.validation('发票审核条件不完整', {
      taxTotal: ['必填且不能为负数'],
    })
  }
  if (!gross || !net.add(tax).eq(gross)) {
    throw ApiError.validation('发票审核条件不完整', {
      grossTotal: ['必须大于零且不含税金额+税额=价税合计'],
    })
  }
  if (!input.partyAccountId || !input.amountAccountId) {
    throw ApiError.validation('发票审核条件不完整', {
      accounts: ['往来科目与金额科目必填'],
    })
  }
  if (tax.gt(0) && !input.taxAccountId) {
    throw ApiError.validation('发票审核条件不完整', {
      taxAccountId: ['有税额时必填'],
    })
  }
}

function invoiceGLEntries(invoice: VatInvoice): GlEntry[] {
  const net = decimal(invoice.netTotal!)
  const tax = decimal(invoice.taxTotal!)
  const gross = decimal(invoice.grossTotal!)
  const partyType = lower(invoice.partyType)
  const entries: GlEntry[] = []
  if (invoice.direction === 'OUTBOUND') {
    entries.push(
      {
        accountId: invoice.partyAccountId!,
        debit: gross,
        credit: '0',
        partyType,
        partyId: invoice.partyId,
      },
      {
        accountId: invoice.amountAccountId!,
        debit: '0',
        credit: net,
      },
    )
    if (tax.gt(0)) {
      entries.push({
        accountId: invoice.taxAccountId!,
        debit: '0',
        credit: tax,
      })
    }
  } else {
    entries.push({
      accountId: invoice.amountAccountId!,
      debit: net,
      credit: '0',
    })
    if (tax.gt(0)) {
      entries.push({
        accountId: invoice.taxAccountId!,
        debit: tax,
        credit: '0',
      })
    }
    entries.push({
      accountId: invoice.partyAccountId!,
      debit: '0',
      credit: gross,
      partyType,
      partyId: invoice.partyId,
    })
  }
  return entries
}

async function reconciliationGLEntries(
  db: DbHandle,
  reconciliations: ReconSeam,
  invoice: VatInvoice,
): Promise<{
  reconEntries: GlEntry[]
  side: TradingSide | null
  reconciliationId: string | null
}> {
  let id = invoice.salReconciliationId
  let side: TradingSide = 'sales'
  if (!id) {
    id = invoice.purReconciliationId
    side = 'purchase'
  }
  if (!id) {
    return { reconEntries: [], side: null, reconciliationId: null }
  }
  const h = await reconciliations.loadForInvoiceAudit(db, side, id)
  if (!h) {
    throw new ApiError('conflict', '关联对账单不存在')
  }
  const invoiceGross = decimal(invoice.grossTotal!)
  if (
    h.reconciliationType !== 'regular' ||
    h.status !== 'confirmed' ||
    h.companyId !== invoice.companyId ||
    upper(h.partyType) !== invoice.partyType ||
    h.partyId !== invoice.partyId ||
    !invoiceGross.eq(decimal(h.gross))
  ) {
    throw new ApiError(
      'conflict',
      '关联对账单必须为同公司、同对手、同金额的已确认常规单',
    )
  }
  // FK 列属于发票表本身，占用检查留在 invoice 所有权内
  const column =
    side === 'sales' ? 'sal_reconciliation_id' : 'pur_reconciliation_id'
  const occupied = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM acc_vat_invoice
      WHERE ${sql.raw(column)}=${id}::uuid
        AND id<>${invoice.id}::uuid
        AND status IN ('audited','voided','reversed')
    ) AS e
  `.execute(db)
  if (occupied.rows[0]?.e) {
    throw new ApiError('conflict', '关联对账单已被其他发票使用')
  }
  const value = decimal(h.gross)
  const partyDB = lower(invoice.partyType)
  if (side === 'sales') {
    return {
      reconEntries: [
        { accountId: h.debitAccountId, debit: value, credit: '0' },
        {
          accountId: h.creditAccountId,
          debit: '0',
          credit: value,
          partyType: partyDB,
          partyId: invoice.partyId,
        },
      ],
      side,
      reconciliationId: id,
    }
  }
  return {
    reconEntries: [
      {
        accountId: h.debitAccountId,
        debit: value,
        credit: '0',
        partyType: partyDB,
        partyId: invoice.partyId,
      },
      { accountId: h.creditAccountId, debit: '0', credit: value },
    ],
    side,
    reconciliationId: id,
  }
}

async function requireAccessibleFile(
  db: DbHandle,
  actor: Actor,
  fileId: string,
): Promise<void> {
  if (actor.superAdmin || actor.allCompanies) {
    const exists = await sql<{ e: boolean }>`
      SELECT EXISTS(SELECT 1 FROM sys_file WHERE id=${fileId}::uuid) AS e
    `.execute(db)
    if (!exists.rows[0]?.e) throw new ApiError('not_found', '文件不存在')
    return
  }
  const accessible = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM sys_file f WHERE f.id=${fileId}::uuid AND (
        f.uploaded_by_id=${actor.userId}::uuid OR EXISTS(
          SELECT 1 FROM sys_attachment a WHERE a.file_id=f.id
            AND a.company_id=ANY(${[...actor.companyIds]}::uuid[])
        )
      )
    ) AS e
  `.execute(db)
  if (!accessible.rows[0]?.e) throw new ApiError('not_found', '文件不存在')
}

// ---- helpers ----

function requireAction(actor: Actor, action: string): void {
  if (!hasPermission(actor, `${PERM}:${action}`)) {
    throw new ApiError('forbidden', '无权限执行此操作')
  }
}

function notFound(): ApiError {
  return new ApiError('not_found', '增值税发票不存在')
}

function actorUserId(actor: Actor): string | null {
  return actor.userId && actor.userId !== '' ? actor.userId : null
}

function invoiceLabel(invoice: VatInvoice): string {
  if (invoice.docNo && invoice.docNo !== '') return invoice.docNo
  if (invoice.invoiceNo) return invoice.invoiceNo
  return invoice.id
}

function invoiceSnap(value: VatInvoice): Record<string, unknown> {
  return {
    doc_no: value.docNo,
    direction: value.direction,
    invoice_date: value.invoiceDate,
    posting_date: value.postingDate,
    party_type: value.partyType,
    party_id: value.partyId,
    invoice_kind: value.invoiceKind,
    invoice_code: value.invoiceCode,
    invoice_no: value.invoiceNo,
    items: JSON.stringify(value.items),
    net_total: value.netTotal,
    tax_total: value.taxTotal,
    gross_total: value.grossTotal,
    remarks: value.remarks,
    status: value.status,
    company_id: value.companyId,
    party_account_id: value.partyAccountId,
    amount_account_id: value.amountAccountId,
    tax_account_id: value.taxAccountId,
    sal_reconciliation_id: value.salReconciliationId,
    pur_reconciliation_id: value.purReconciliationId,
  }
}

function requireDate(value: string, field: string): string {
  const v = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw ApiError.validation('日期参数不合法', {
      [field]: ['格式应为 YYYY-MM-DD'],
    })
  }
  return v
}

function parseOptionalDecimal(
  value: string | null,
  field: string,
  positive: boolean,
  nonnegative: boolean,
) {
  if (value == null) return null
  const trimmed = value.trim()
  if (!isDecimalString(trimmed)) {
    throw ApiError.validation('数值参数不合法', {
      [field]: ['必须是十进制字符串'],
    })
  }
  const d = decimal(trimmed)
  if (positive && !d.gt(0)) {
    throw ApiError.validation('数值参数不合法', { [field]: ['必须大于零'] })
  }
  if (nonnegative && d.isNegative()) {
    throw ApiError.validation('数值参数不合法', { [field]: ['不能为负数'] })
  }
  return d
}

/** jsonb[] 字面量：逐元素 `::jsonb`，避免 jsonb_array_elements 对 text 参数二次编码失败 */
function itemsArraySql(items: Record<string, unknown>[]) {
  if (items.length === 0) return sql`ARRAY[]::jsonb[]`
  const elems = items.map((item) => sql`${JSON.stringify(item)}::jsonb`)
  return sql`ARRAY[${sql.join(elems, sql`, `)}]::jsonb[]`
}

function lower(value: string): string {
  return value.trim().toLowerCase()
}

function upper(value: string): string {
  return value.trim().toUpperCase()
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t === '' ? null : t
}

function optStr(value: unknown): string | null {
  if (value == null) return null
  return String(value)
}

function optId(value: unknown): string | null {
  if (value == null) return null
  return String(value)
}

function wireDec(value: unknown): string | null {
  if (value == null) return null
  return toDecimalString(decimal(String(value)))
}

function dateOnly(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

function datetimeIso(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}
