/**
 * 增值税发票：销项/进项/费用报销票生命周期，全量走标准动作内核。
 *
 * - CRUD 与三个转移（audit / void / reverse）都是内核派生：
 *   转移 effect 直调 GL 引擎（过账/作废/红冲），`after` 挂对账结单与重开接缝。
 * - 领域校验以钩子注入：`validate` 跑纯函数 normalizeInput（形状 + 组合规则 +
 *   trim/空串归一），`beforeWrite` 跑要查库的引用校验。
 * - 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 *   内核内部走 listAuthorized / loadAuthorized(forUpdate) / assertCompanyWritable。
 *
 * `items` 是 jsonb[]：postgres.js 双向直通（读回 JS 数组、写入按数组编码），
 * 故 meta 声明为可写 json 字段即可，无需 ARRAY[...]::jsonb[] 手写字面量。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { FileService } from '~/platform/files/service.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { ReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import type { TradingSide } from '~/modules/trading/common.ts'
import { auditStamp, createStandardService } from '~/platform/standard/service.ts'
import { VAT_INVOICE_RESOURCE_NAME } from './meta.ts'
import { recognizeVatInvoice, type OcrDeps, type OcrPrefill } from './ocr.ts'

export { VAT_INVOICE_RESOURCE_NAME } from './meta.ts'

export type InvoiceStatus = 'DRAFT' | 'AUDITED' | 'VOIDED' | 'REVERSED'
export type InvoiceDirection = 'INBOUND' | 'OUTBOUND'
export type InvoicePartyType = 'SUPPLIER' | 'CUSTOMER' | 'COMPANY' | 'EMPLOYEE'

/** wire 形单据（内核口径：date 为 YYYY-MM-DD 字符串，datetime 为 Date） */
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
  auditedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  partyAccountId: string | null
  amountAccountId: string | null
  taxAccountId: string | null
  mirrorInvoiceId: string | null
  createdById: string | null
  auditedById: string | null
  salReconciliationId: string | null
  purReconciliationId: string | null
  [key: string]: unknown
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

const VOUCHER_TYPE = 'acc.vat_invoice'

const KINDS = new Set([
  'SPECIAL',
  'NORMAL',
  'ELECTRONIC_SPECIAL',
  'ELECTRONIC_NORMAL',
  'DIGITAL_SPECIAL',
  'DIGITAL_NORMAL',
])

const WRITE_MAPPINGS = [
  { code: '23505', message: '同一公司内发票号码或内部编号冲突' },
  { code: '23503', message: '增值税发票引用不存在' },
] as const

export type VatInvoiceService = ReturnType<typeof createVatInvoiceService>

export interface VatInvoiceServiceDeps {
  gl: GlEngine
  reconciliations: Pick<
    ReconciliationService,
    'closeFromInvoice' | 'reopenFromInvoice' | 'existsForInvoice' | 'loadForInvoiceAudit'
  >
  files?: Pick<FileService, 'readReachableFile'> | null
  ocr?: OcrDeps
  /** 判定归宿解析（列表/单条/写侧三个执行点共用） */
  registry: Registry
}

export function createVatInvoiceService(
  db: Kysely<Database>,
  numbering: NumberingService,
  deps: VatInvoiceServiceDeps,
) {
  const gl = deps.gl
  const reconciliations = deps.reconciliations
  const files = deps.files ?? null

  const base = createStandardService<VatInvoice>({
    db,
    registry: deps.registry,
    resource: VAT_INVOICE_RESOURCE_NAME,
    defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
    writeErrors: [...WRITE_MAPPINGS],
    // 编号一律系统生成，手填 400（ADR 2026-08-06-system-generated-numbering）；
    // 内核按 draft 全量派生 values（含 invoice_date），键名与 meta 字段天然一致
    numbering: { service: numbering, field: 'docNo' },
    hooks: {
      validate: ({ draft }) => {
        // 纯函数：形状/组合校验 + trim/空串归一（update 跑在 before+patch 合并形上）
        Object.assign(draft, normalizeInput(draft as unknown as VatInvoiceInput))
      },
      beforeWrite: async (trx, { action, draft, before }) => {
        await validateReferences(
          trx,
          reconciliations,
          draft as unknown as NormalizedInput,
          action === 'update' ? String(before!.id) : null,
          false,
        )
      },
      insertColumns: ({ permit }) => ({ created_by_id: permit.actor.userId || null }),
    },
    workflow: {
      mutableMessage: '仅草稿发票可修改或删除',
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: '仅草稿发票可审核',
          stamps: ({ permit, input }) => ({
            ...auditStamp(permit),
            posting_date: input.postingDate,
          }),
          effect: async (trx, { before, input }) => {
            const invoice = before as VatInvoice
            await validateReferences(trx, reconciliations, toInput(invoice), invoice.id, true)
            const entries = invoiceGLEntries(invoice)
            const reconEntries = await reconciliationGLEntries(trx, reconciliations, invoice)
            entries.push(...reconEntries)
            await gl.post(
              trx,
              {
                type: VOUCHER_TYPE,
                id: invoice.id,
                no: invoiceLabel(invoice),
                companyId: invoice.companyId,
                postingDate: String(input.postingDate),
              },
              entries,
            )
          },
          after: async (trx, { permit, before }) => {
            const target = reconTargetOf(before as VatInvoice)
            if (target) {
              await reconciliations.closeFromInvoice(trx, permit.actor, target.side, target.id)
            }
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: '仅已审核发票可作废或红冲',
          effect: async (trx, { before }) => {
            await assertNotClaimedByExpense(trx, String(before.id))
            await gl.cancel(trx, { type: VOUCHER_TYPE, id: String(before.id) })
            // 对账关联在收口时解除（重开由 after 钩子驱动）
            return { sal_reconciliation_id: null, pur_reconciliation_id: null }
          },
          after: reopenReconciliations,
        },
        {
          key: 'reverse',
          label: '红冲',
          from: ['AUDITED'],
          to: 'REVERSED',
          guardMessage: '仅已审核发票可作废或红冲',
          effect: async (trx, { before, input }) => {
            await assertNotClaimedByExpense(trx, String(before.id))
            await gl.reverse(
              trx,
              { type: VOUCHER_TYPE, id: String(before.id) },
              String(input.postingDate),
            )
            return {
              red_invoice_no: (input.redInvoiceNo as string | null | undefined) ?? null,
              sal_reconciliation_id: null,
              pur_reconciliation_id: null,
            }
          },
          after: reopenReconciliations,
        },
      ],
    },
  })

  /** 作废/红冲后重开关联对账单（骨架 afterVoid 的原样搬迁） */
  async function reopenReconciliations(
    trx: TrxHandle,
    ctx: { permit: Permit; before: Record<string, unknown> },
  ): Promise<void> {
    const before = ctx.before as VatInvoice
    if (before.salReconciliationId) {
      await reconciliations.reopenFromInvoice(trx, ctx.permit.actor, 'sales', before.salReconciliationId)
    }
    if (before.purReconciliationId) {
      await reconciliations.reopenFromInvoice(trx, ctx.permit.actor, 'purchase', before.purReconciliationId)
    }
  }

  async function create(permit: Permit, input: VatInvoiceInput): Promise<VatInvoice> {
    // 入参校验（400）先于公司边界（404）：内核 create 的 assertCompanyWritable 在钩子之前
    const normalized = normalizeInput(input)
    return base.create(permit, normalized as unknown as Record<string, unknown>)
  }

  /** present-key 语义：出现即写、null 清空、缺省不动（取代旧的 *Present 布尔） */
  async function update(
    permit: Permit,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<VatInvoice> {
    return base.update(permit, id, patch)
  }

  async function audit(permit: Permit, id: string, postingDate: string): Promise<VatInvoice> {
    const posting = requireDate(postingDate, 'postingDate')
    return base.transition(permit, id, 'audit', { postingDate: posting })
  }

  async function voidInvoice(permit: Permit, id: string): Promise<VatInvoice> {
    return base.transition(permit, id, 'void')
  }

  async function reverse(
    permit: Permit,
    id: string,
    input: { postingDate: string; redInvoiceNo?: string | null },
  ): Promise<VatInvoice> {
    const posting = requireDate(input.postingDate ?? '', 'postingDate')
    return base.transition(permit, id, 'reverse', {
      postingDate: posting,
      redInvoiceNo: input.redInvoiceNo ?? null,
    })
  }

  async function ocr(permit: Permit, fileId: string): Promise<OcrPrefill> {
    if (!files) {
      throw new ApiError('internal', 'OCR 服务未配置')
    }
    // 文件可达性归平台判定（码 forbidden / 行级 not_found），本域不再自造闸
    const { file, content } = await files.readReachableFile(permit.actor, fileId)
    return recognizeVatInvoice(db, file, content, deps.ocr)
  }

  return {
    list: (permit: Permit, query: Partial<ListQuery>) => base.list(permit, query),
    get: (permit: Permit, id: string) => base.get(permit, id),
    create,
    update,
    remove: (permit: Permit, id: string) => base.remove(permit, id),
    audit,
    void: voidInvoice,
    reverse,
    ocr,
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
  const direction = upper(String(input.direction ?? '')) as InvoiceDirection
  const partyType = upper(String(input.partyType ?? '')) as InvoicePartyType
  const invoiceKind = upper(String(input.invoiceKind ?? ''))
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

/** 已落库单据 → 审核校验入参（wire 形与 NormalizedInput 同键） */
function toInput(value: VatInvoice): NormalizedInput {
  return normalizeInput(value as unknown as VatInvoiceInput)
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

/** 已被未作废报销单挂票的发票不能作废/红冲 */
async function assertNotClaimedByExpense(db: DbHandle, id: string): Promise<void> {
  const referenced = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM acc_expense_report_item i
      JOIN acc_expense_report r ON r.id=i.report_id
      WHERE i.invoice_id=${id}::uuid AND r.status<>'voided'
    ) AS e
  `.execute(db)
  if (referenced.rows[0]?.e) {
    throw new ApiError('conflict', '发票已被报销单引用,请先在报销单上移除该行或作废报销单')
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

/** 关联对账单（销售优先，其次采购）；未关联为 null */
function reconTargetOf(invoice: VatInvoice): { side: TradingSide; id: string } | null {
  if (invoice.salReconciliationId) return { side: 'sales', id: invoice.salReconciliationId }
  if (invoice.purReconciliationId) return { side: 'purchase', id: invoice.purReconciliationId }
  return null
}

async function reconciliationGLEntries(
  db: DbHandle,
  reconciliations: ReconSeam,
  invoice: VatInvoice,
): Promise<GlEntry[]> {
  const target = reconTargetOf(invoice)
  if (!target) return []
  const { side, id } = target
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
    return [
      { accountId: h.debitAccountId, debit: value, credit: '0' },
      {
        accountId: h.creditAccountId,
        debit: '0',
        credit: value,
        partyType: partyDB,
        partyId: invoice.partyId,
      },
    ]
  }
  return [
    {
      accountId: h.debitAccountId,
      debit: value,
      credit: '0',
      partyType: partyDB,
      partyId: invoice.partyId,
    },
    { accountId: h.creditAccountId, debit: '0', credit: value },
  ]
}

// ---- helpers ----

function invoiceLabel(invoice: VatInvoice): string {
  if (invoice.docNo && invoice.docNo !== '') return invoice.docNo
  if (invoice.invoiceNo) return invoice.invoiceNo
  return invoice.id
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
