/**
 * 费用报销单：单头 + 报销行走标准动作内核（CRUD + workflow 转移），
 * 审核/作废两个转移的 effect 直调 GL 引擎（取代 posting/skeleton 的编排 spec）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit——
 * 内核内部走 listAuthorized / loadAuthorized(forUpdate) / assertCompanyWritable。
 * 行（accExpenseReportItems）是 via(母单)，判定递归母单；母单锁 + 草稿门由子行内核编排。
 *
 * 内核之外只剩一层薄壳（wrapper）：日期/十进制的**格式**校验必须先于内核
 * 规范化跑（内核 normalizeInput 直接 `decimal()`，脏值会炸成 500），
 * 审核入参 postingDate 的校验亦先于状态门——两处顺序与迁移前逐字一致。
 */
import { decimal, isDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createStandardChildService } from '~/platform/standard/child.ts'
import { auditStamp, createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { conflict, parseDecimal, requireDate, upper } from './common.ts'

export const EXPENSE_REPORT_RESOURCE = 'accExpenseReports'
export const EXPENSE_REPORT_ITEM_RESOURCE = 'accExpenseReportItems'

const LABEL = '费用报销单'
const ITEM_LABEL = '报销行'
const VOUCHER = 'acc.expense_report'

const WRITE_MAP = [
  { code: '23505', message: '报销单编号冲突' },
  { code: '23503', message: '报销单引用不存在' },
] as const

/** wire 形单头（内核口径：date 为 YYYY-MM-DD 字符串，datetime 为 Date） */
export interface ExpenseReport {
  id: string
  docNo: string
  expenseDate: string
  postingDate: string | null
  remarks: string | null
  status: 'DRAFT' | 'AUDITED' | 'VOIDED'
  auditedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  employeeId: string
  paymentAccountId: string
  createdById: string | null
  auditedById: string | null
  [key: string]: unknown
}

export interface ExpenseReportItem {
  id: string
  idx: number
  kind: 'INVOICED' | 'MANUAL'
  summary: string | null
  amount: string | null
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  reportId: string
  companyId: string
  invoiceId: string | null
  expenseAccountId: string | null
  /** 投影列：母单编号（审计 record_label `单号#行号` 用；不进 HTTP DTO） */
  reportDocNo: string
  [key: string]: unknown
}

/** 行投影：母单编号随行带出（子行自己没有名称列） */
const ITEM_SOURCE = sql`
  FROM (
    SELECT i.*, r.doc_no AS report_doc_no
    FROM acc_expense_report_item i
    JOIN acc_expense_report r ON r.id = i.report_id
  ) acc_expense_report_item
`
const ITEM_SELECT_EXTRA = sql`report_doc_no`

async function validateEmployeeAndAccount(
  db: DbHandle, companyId: string, employeeId: string, accountId: string,
) {
  const rows = await sql<{ employee: boolean; account: boolean }>`
    SELECT
      EXISTS(SELECT 1 FROM hr_employees WHERE id=${employeeId}::uuid) AS employee,
      EXISTS(SELECT 1 FROM bas_account WHERE id=${accountId}::uuid AND company_id=${companyId}::uuid
        AND active AND NOT is_group) AS account
  `.execute(db)
  if (!rows.rows[0]?.employee || !rows.rows[0]?.account) {
    throw ApiError.validation(`${LABEL}参数不合法`, { references: ['员工或付款科目不合法'] })
  }
}

/**
 * 十进制格式前置闸：内核 normalizeInput 会直接 `decimal()`，脏值将抛出非 ApiError。
 * 文案与 `parseDecimal` 的首个分支逐字一致（正数校验仍留在领域钩子里）。
 */
function assertDecimalShape(value: unknown, field: string): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'string' || !isDecimalString(value.trim())) {
    throw ApiError.validation('数值参数不合法', { [field]: ['必须是十进制字符串'] })
  }
}

export type ExpenseService = ReturnType<typeof createExpenseService>

export function createExpenseService(
  db: Kysely<Database>,
  numbering: NumberingService,
  gl: GlEngine,
  registry: Registry,
) {
  /** 报销单过账分录（挂票行取发票价税合计，无票行取行金额） */
  async function expenseEntries(
    trx: DbHandle, report: ExpenseReport,
  ): Promise<{ entries: GlEntry[]; total: ReturnType<typeof decimal> }> {
    const rows = await sql<{
      kind: string; amount: string | null; expense_account_id: string | null; invoice_id: string | null
    }>`
      SELECT i.kind,i.amount::text,i.expense_account_id,i.invoice_id
      FROM acc_expense_report_item i WHERE i.report_id=${report.id}::uuid
      ORDER BY i.idx,i.id FOR UPDATE OF i
    `.execute(trx)
    const entries: GlEntry[] = []
    let total = decimal(0)
    for (const item of rows.rows) {
      if (item.kind === 'invoiced') {
        if (!item.invoice_id) throw conflict('挂票行发票状态已变化')
        const inv = await sql<{ gross_total: string | null; party_account_id: string | null }>`
          SELECT gross_total::text, party_account_id FROM acc_vat_invoice
          WHERE id=${item.invoice_id}::uuid AND company_id=${report.companyId}::uuid
            AND party_type='employee' AND party_id=${report.employeeId}::uuid
            AND direction='inbound' AND status='audited' FOR UPDATE
        `.execute(trx)
        const row = inv.rows[0]
        if (!row?.party_account_id || row.gross_total == null) throw conflict('挂票行发票状态已变化')
        const claimed = await sql<{ e: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM acc_expense_report_item other
            JOIN acc_expense_report r ON r.id=other.report_id
            WHERE other.invoice_id=${item.invoice_id}::uuid AND other.report_id<>${report.id}::uuid AND r.status<>'voided'
          ) AS e
        `.execute(trx)
        if (claimed.rows[0]?.e) throw conflict('挂票发票已被其他报销单占用')
        const value = decimal(row.gross_total)
        entries.push({
          accountId: row.party_account_id, debit: value, credit: '0',
          partyType: 'employee', partyId: report.employeeId,
        })
        total = total.add(value)
      } else {
        if (!item.expense_account_id || item.amount == null) throw conflict('无票报销行不完整')
        const value = decimal(item.amount)
        entries.push({ accountId: item.expense_account_id, debit: value, credit: '0' })
        total = total.add(value)
      }
    }
    return { entries, total }
  }

  const reports = createStandardService<ExpenseReport>({
    db,
    registry,
    resource: EXPENSE_REPORT_RESOURCE,
    defaultOrder: sql`"id"`,
    writeErrors: [...WRITE_MAP],
    // 编号一律系统生成，手填 400（ADR 2026-08-06-system-generated-numbering）；
    // 内核按 draft 全量派生 values（含 expense_date），键名与 meta 字段天然一致
    numbering: { service: numbering, field: 'docNo' },
    hooks: {
      beforeWrite: async (trx, { draft }) => {
        await validateEmployeeAndAccount(
          trx, String(draft.companyId), String(draft.employeeId), String(draft.paymentAccountId),
        )
      },
      // created_by_id 是 readonly 列且本资源不声明 owner 绑定：随 INSERT 落库，保审计快照完整
      insertColumns: ({ permit }) => ({ created_by_id: permit.actor.userId || null }),
    },
    workflow: {
      mutableMessage: '仅草稿报销单可修改或删除',
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: '仅草稿报销单可审核',
          stamps: ({ permit, input }) => ({
            ...auditStamp(permit),
            posting_date: input.postingDate,
          }),
          effect: async (trx, { before, input }) => {
            const report = before as ExpenseReport
            await validateEmployeeAndAccount(
              trx, report.companyId, report.employeeId, report.paymentAccountId,
            )
            const { entries, total } = await expenseEntries(trx, report)
            if (total.isZero()) throw conflict('报销单必须至少有一行')
            // 金额口径 Decimal|string（引擎 interface 瘦身后）
            entries.push({ accountId: report.paymentAccountId, debit: '0', credit: total })
            await gl.post(
              trx,
              {
                type: VOUCHER,
                id: report.id,
                no: report.docNo,
                companyId: report.companyId,
                postingDate: String(input.postingDate),
              },
              entries,
            )
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: '仅已审核报销单可作废',
          effect: async (trx, { before }) => {
            await gl.cancel(trx, { type: VOUCHER, id: String(before.id) })
          },
        },
      ],
    },
  })

  /** 挂票/无票行的领域校验（母单已锁、已过草稿门）；返回落库用的规范值 */
  async function validateExpenseItem(
    trx: DbHandle, report: ExpenseReport,
    input: Record<string, unknown>,
    ownId: string | null,
  ): Promise<{ kind: string; amount: string | null }> {
    const kind = upper(String(input.kind ?? ''))
    if (kind === 'INVOICED') {
      if (!input.invoiceId || input.summary != null || input.amount != null || input.expenseAccountId != null) {
        throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { kind: ['挂票行仅允许发票与备注'] })
      }
      const inv = await sql<{
        company_id: string; party_type: string; party_id: string; direction: string; status: string; claimed: boolean
      }>`
        SELECT company_id,party_type,party_id,direction,status,
          EXISTS(SELECT 1 FROM acc_expense_report_item other
            JOIN acc_expense_report r ON r.id=other.report_id
            WHERE other.invoice_id=inv.id AND other.id<>${ownId ?? '00000000-0000-0000-0000-000000000000'}::uuid
              AND r.status<>'voided') AS claimed
        FROM acc_vat_invoice inv WHERE id=${String(input.invoiceId)}::uuid FOR UPDATE
      `.execute(trx)
      const row = inv.rows[0]
      if (
        !row || row.company_id !== report.companyId || row.party_type !== 'employee' ||
        row.party_id !== report.employeeId || row.direction !== 'inbound' ||
        row.status !== 'audited' || row.claimed
      ) {
        throw conflict('挂票发票必须为同公司同员工的已审核未报销开入发票')
      }
      return { kind, amount: null }
    }
    if (kind === 'MANUAL') {
      const summary = typeof input.summary === 'string' ? input.summary : null
      if (input.invoiceId != null || !summary?.trim() || !input.amount || !input.expenseAccountId) {
        throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { kind: ['无票行须填写摘要、正金额与费用科目'] })
      }
      const amount = parseDecimal(String(input.amount), 'amount', true, false)
      const valid = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM bas_account WHERE id=${String(input.expenseAccountId)}::uuid
          AND company_id=${report.companyId}::uuid AND active AND NOT is_group) AS e
      `.execute(trx)
      if (!valid.rows[0]?.e) {
        throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { expenseAccountId: ['费用科目不合法'] })
      }
      return { kind, amount: amount.toFixed() }
    }
    throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { kind: ['只允许 INVOICED 或 MANUAL'] })
  }

  const items = createStandardChildService<ExpenseReportItem>({
    db,
    registry,
    resource: EXPENSE_REPORT_ITEM_RESOURCE,
    notFound: `${ITEM_LABEL}不存在`,
    defaultOrder: sql`"id"`,
    writeErrors: [...WRITE_MAP],
    projection: {
      source: ITEM_SOURCE,
      selectExtra: ITEM_SELECT_EXTRA,
      mapExtra: (row) => ({ reportDocNo: String(row.report_doc_no) }),
    },
    // 行审计标签 `单号#行号`（迁移前逐字）
    recordLabel: (item) => `${String(item.reportDocNo)}#${String(item.idx)}`,
    parent: {
      resource: EXPENSE_REPORT_RESOURCE,
      fkField: 'reportId',
      notFound: `${LABEL}不存在`,
      inheritFields: ['companyId'],
      gate: (report) => {
        if (report.status !== 'DRAFT') throw conflict('仅草稿报销单可增删改行')
      },
    },
    hooks: {
      validate: ({ draft }) => {
        if (Number(draft.idx) < 1) {
          throw ApiError.validation(`${ITEM_LABEL}参数不合法`, { idx: ['必须大于零'] })
        }
      },
      beforeWrite: async (trx, { draft, parent, before }) => {
        const normalized = await validateExpenseItem(
          trx, parent as ExpenseReport, draft, before ? String(before.id) : null,
        )
        draft.kind = normalized.kind
        draft.amount = normalized.amount
      },
    },
  })

  // —— 单头（wrapper 只做格式前置校验，其余全归内核） ——

  async function createReport(permit: Permit, input: {
    companyId: string; docNo?: string | null; expenseDate: string
    postingDate?: string | null; remarks?: string | null
    employeeId: string; paymentAccountId: string
  }): Promise<ExpenseReport> {
    // 入参校验（400）先于公司边界（404）
    const expenseDate = requireDate(input.expenseDate, 'expenseDate')
    if (!input.employeeId || !input.paymentAccountId) {
      throw ApiError.validation(`${LABEL}参数不合法`, { references: ['员工与付款科目必填'] })
    }
    const postingDate = input.postingDate ? requireDate(input.postingDate, 'postingDate') : null
    const docNo = (input.docNo ?? '').trim()
    return reports.create(permit, {
      companyId: input.companyId,
      docNo: docNo === '' ? undefined : docNo,
      expenseDate,
      postingDate,
      remarks: input.remarks ?? null,
      employeeId: input.employeeId,
      paymentAccountId: input.paymentAccountId,
    })
  }

  /** present-key 语义：出现即写、null 清空、缺省不动（取代旧的 *Present 布尔） */
  async function updateReport(
    permit: Permit, id: string, patch: Record<string, unknown>,
  ): Promise<ExpenseReport> {
    const next: Record<string, unknown> = { ...patch }
    if ('docNo' in patch) {
      const docNo = typeof patch.docNo === 'string' ? patch.docNo.trim() : ''
      if (docNo === '') throw ApiError.validation(`${LABEL}参数不合法`, { docNo: ['不能为空'] })
      next.docNo = docNo
    }
    if (patch.expenseDate !== undefined) {
      next.expenseDate = requireDate(String(patch.expenseDate), 'expenseDate')
    }
    if ('postingDate' in patch) {
      next.postingDate = patch.postingDate ? requireDate(String(patch.postingDate), 'postingDate') : null
    }
    if ('remarks' in patch) next.remarks = patch.remarks ?? null
    return reports.update(permit, id, next)
  }

  /** 审核：过账日期校验先于状态门（与迁移前顺序一致） */
  async function auditReport(permit: Permit, id: string, postingDate: string): Promise<ExpenseReport> {
    const posting = requireDate(postingDate, 'postingDate')
    return reports.transition(permit, id, 'audit', { postingDate: posting })
  }

  async function voidReport(permit: Permit, id: string): Promise<ExpenseReport> {
    return reports.transition(permit, id, 'void')
  }

  // —— 行 ——

  async function createItem(permit: Permit, input: Record<string, unknown>): Promise<ExpenseReportItem> {
    assertDecimalShape(input.amount, 'amount')
    return items.create(permit, input)
  }

  async function updateItem(
    permit: Permit, id: string, patch: Record<string, unknown>,
  ): Promise<ExpenseReportItem> {
    if ('amount' in patch) assertDecimalShape(patch.amount, 'amount')
    return items.update(permit, id, patch)
  }

  return {
    listReports: (permit: Permit, query: Partial<ListQuery>) => reports.list(permit, query),
    getReport: (permit: Permit, id: string) => reports.get(permit, id),
    createReport,
    updateReport,
    deleteReport: (permit: Permit, id: string) => reports.remove(permit, id),
    auditReport,
    voidReport,
    listItems: (permit: Permit, query: Partial<ListQuery>) => items.list(permit, query),
    getItem: (permit: Permit, id: string) => items.get(permit, id),
    createItem,
    updateItem,
    deleteItem: (permit: Permit, id: string) => items.remove(permit, id),

    _reportsForContract: (): StandardService => reports as unknown as StandardService,
  }
}
