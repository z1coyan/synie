/**
 * 承兑票据 / 交易 / 持有段重放。
 *
 * 承兑交易（accBillTransactions）走标准动作内核：list/get/update/remove +
 * workflow 转移（audit/void），转移 effect 调 GL 引擎，`after` 跑持有段重放
 * （replayBill 必须看到翻转后的状态，故挂在翻转+审计之后）。
 * 三处按动作/资源弹射，原因见迁移决策日志：
 * - 交易 `create`：RECEIVE 可携 `billAttrs` 联动建票据主档（非本资源字段，
 *   内核 normalizeInput 会丢弃），且取号 values 口径特殊；
 * - 票据主档（accBills）：无公司列（global），可见性由「名下有可达交易」的
 *   EXISTS 谓词派生，内核 list/load 无 extraWhere 接口，迁了会放宽授权；
 * - 持有段（accBillHoldings）：只读投影，meta 无审计声明、无写动作词表。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import {
  auditCreated, auditDiff, writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { FileService } from '~/platform/files/service.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { compileRowFilter } from '~/db/authz-sql.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized } from '~/db/load.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { mapRow, snapshot } from '~/platform/standard/fields.ts'
import { auditStamp, createStandardService } from '~/platform/standard/service.ts'
import {
  actorUserId, asDateOnly, asDateOnlyOrNull, asIso, conflict, lower,
  notFound, parseDecimal, requireDate, upper,
  wireDec, wireDecRequired, wireEnum,
} from './common.ts'
import {
  billHoldingResourceMeta, billResourceMeta, billTransactionResourceMeta,
} from './meta.ts'
import { replaySegments, segmentAmount, type ReplayTx } from './bill-replay.ts'
import { recognizeBankAcceptance, type OcrDeps, type OcrPrefill } from './ocr.ts'

export interface Bill {
  id: string; billNo: string; billKind: string; issueDate: string | null
  dueDate: string; faceAmount: string | null
  drawerName: string | null; drawerAccount: string | null
  drawerBankName: string | null; drawerBankNo: string | null
  payeeName: string | null; payeeAccount: string | null
  payeeBankName: string | null; payeeBankNo: string | null
  acceptorName: string | null; acceptorAccount: string | null
  acceptorBankName: string | null; acceptorBankNo: string | null
  transferable: boolean; acceptanceDate: string | null; remarks: string | null
  insertedAt: string; updatedAt: string
}

/** wire 形承兑交易（内核口径：date 为 YYYY-MM-DD 字符串，datetime 为 Date） */
export interface BillTransaction {
  id: string; docNo: string | null; transactionType: string; occurredOn: string
  subStart: number; subEnd: number; amount: string
  partyType: string | null; partyId: string | null
  discountOrg: string | null; discountRate: string | null
  interest: string | null; netAmount: string | null
  postingDate: string | null; status: string; auditedAt: Date | null
  remarks: string | null; insertedAt: Date; updatedAt: Date
  companyId: string; bankAccountId: string; toBankAccountId: string | null
  billId: string; billAccountId: string | null; settleAccountId: string | null
  interestAccountId: string | null; createdById: string | null; auditedById: string | null
  [key: string]: unknown
}

export interface BillHolding {
  id: string; billNo: string; subStart: number; subEnd: number; amount: string
  dueDate: string; acquiredOn: string; insertedAt: string; companyId: string
  bankAccountId: string; billId: string; sourceTransactionId: string
}

export interface BillAttrs {
  billNo: string; billKind: string; issueDate?: string | null; dueDate: string
  faceAmount?: string | null
  drawerName?: string | null; drawerAccount?: string | null
  drawerBankName?: string | null; drawerBankNo?: string | null
  payeeName?: string | null; payeeAccount?: string | null
  payeeBankName?: string | null; payeeBankNo?: string | null
  acceptorName?: string | null; acceptorAccount?: string | null
  acceptorBankName?: string | null; acceptorBankNo?: string | null
  transferable?: boolean | null; acceptanceDate?: string | null; remarks?: string | null
}

/** wire 可能是 camelCase 或 snake_case（verify/Go 客户端混用） */
function normalizeBillAttrs(raw: Record<string, unknown> | BillAttrs): BillAttrs {
  const r = raw as Record<string, unknown>
  const pick = (camel: string, snake: string): unknown =>
    r[camel] !== undefined ? r[camel] : r[snake]
  return {
    billNo: String(pick('billNo', 'bill_no') ?? ''),
    billKind: String(pick('billKind', 'bill_kind') ?? ''),
    issueDate: (pick('issueDate', 'issue_date') as string | null | undefined) ?? null,
    dueDate: String(pick('dueDate', 'due_date') ?? ''),
    faceAmount: (pick('faceAmount', 'face_amount') as string | null | undefined) ?? null,
    drawerName: (pick('drawerName', 'drawer_name') as string | null | undefined) ?? null,
    drawerAccount: (pick('drawerAccount', 'drawer_account') as string | null | undefined) ?? null,
    drawerBankName: (pick('drawerBankName', 'drawer_bank_name') as string | null | undefined) ?? null,
    drawerBankNo: (pick('drawerBankNo', 'drawer_bank_no') as string | null | undefined) ?? null,
    payeeName: (pick('payeeName', 'payee_name') as string | null | undefined) ?? null,
    payeeAccount: (pick('payeeAccount', 'payee_account') as string | null | undefined) ?? null,
    payeeBankName: (pick('payeeBankName', 'payee_bank_name') as string | null | undefined) ?? null,
    payeeBankNo: (pick('payeeBankNo', 'payee_bank_no') as string | null | undefined) ?? null,
    acceptorName: (pick('acceptorName', 'acceptor_name') as string | null | undefined) ?? null,
    acceptorAccount: (pick('acceptorAccount', 'acceptor_account') as string | null | undefined) ?? null,
    acceptorBankName:
      (pick('acceptorBankName', 'acceptor_bank_name') as string | null | undefined) ?? null,
    acceptorBankNo: (pick('acceptorBankNo', 'acceptor_bank_no') as string | null | undefined) ?? null,
    transferable: (pick('transferable', 'transferable') as boolean | null | undefined) ?? null,
    acceptanceDate:
      (pick('acceptanceDate', 'acceptance_date') as string | null | undefined) ?? null,
    remarks: (pick('remarks', 'remarks') as string | null | undefined) ?? null,
  }
}

const BILL_META = billResourceMeta()
const TX_META = billTransactionResourceMeta()
const BILL_AUDIT = auditFieldsOf(BILL_META)
const TX_AUDIT = auditFieldsOf(TX_META)
const WRITE_MAP = [
  { code: '23505', message: '票据号码或单据编号冲突' },
  { code: '23503', message: '票据业务引用不存在' },
] as const
const VOUCHER = 'acc.bill_transaction'
const TYPES = new Set(['RECEIVE','ENDORSE','SETTLE','DISCOUNT','REALLOCATE'])

export const BILL_RESOURCE = 'accBills'
export const BILL_TRANSACTION_RESOURCE = 'accBillTransactions'
export const BILL_HOLDING_RESOURCE = 'accBillHoldings'

const BILL_TABLE = 'acc_bill'
const BILL_TX_TABLE = 'acc_bill_transaction'
const BILL_HOLDING_TABLE = 'acc_bill_holding'
/** 票据可见性的派生别名：EXISTS 子查询里代表交易行 */
const BILL_SCOPE_TX_ALIAS = 'scope_tx'

function mapBill(row: Record<string, unknown>): Bill {
  return {
    id: String(row.id), billNo: String(row.bill_no), billKind: wireEnum(row.bill_kind),
    issueDate: asDateOnlyOrNull(row.issue_date), dueDate: asDateOnly(row.due_date),
    faceAmount: wireDec(row.face_amount),
    drawerName: row.drawer_name == null ? null : String(row.drawer_name),
    drawerAccount: row.drawer_account == null ? null : String(row.drawer_account),
    drawerBankName: row.drawer_bank_name == null ? null : String(row.drawer_bank_name),
    drawerBankNo: row.drawer_bank_no == null ? null : String(row.drawer_bank_no),
    payeeName: row.payee_name == null ? null : String(row.payee_name),
    payeeAccount: row.payee_account == null ? null : String(row.payee_account),
    payeeBankName: row.payee_bank_name == null ? null : String(row.payee_bank_name),
    payeeBankNo: row.payee_bank_no == null ? null : String(row.payee_bank_no),
    acceptorName: row.acceptor_name == null ? null : String(row.acceptor_name),
    acceptorAccount: row.acceptor_account == null ? null : String(row.acceptor_account),
    acceptorBankName: row.acceptor_bank_name == null ? null : String(row.acceptor_bank_name),
    acceptorBankNo: row.acceptor_bank_no == null ? null : String(row.acceptor_bank_no),
    transferable: Boolean(row.transferable),
    acceptanceDate: asDateOnlyOrNull(row.acceptance_date),
    remarks: row.remarks == null ? null : String(row.remarks),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
  }
}

function mapHolding(row: Record<string, unknown>): BillHolding {
  return {
    id: String(row.id), billNo: String(row.bill_no),
    subStart: Number(row.sub_start), subEnd: Number(row.sub_end),
    amount: wireDecRequired(row.amount), dueDate: asDateOnly(row.due_date),
    acquiredOn: asDateOnly(row.acquired_on), insertedAt: asIso(row.inserted_at),
    companyId: String(row.company_id), bankAccountId: String(row.bank_account_id),
    billId: String(row.bill_id), sourceTransactionId: String(row.source_transaction_id),
  }
}

function billSnap(b: Bill): Record<string, unknown> {
  return {
    bill_no: b.billNo, bill_kind: b.billKind, issue_date: b.issueDate,
    due_date: b.dueDate, face_amount: b.faceAmount, transferable: b.transferable, remarks: b.remarks,
  }
}

async function loadBill(db: DbHandle, id: string, lock: boolean): Promise<Bill> {
  const rows = lock
    ? await sql<Record<string, unknown>>`
        SELECT id,bill_no,bill_kind,issue_date,due_date,face_amount,drawer_name,drawer_account,
          drawer_bank_name,drawer_bank_no,payee_name,payee_account,payee_bank_name,payee_bank_no,
          acceptor_name,acceptor_account,acceptor_bank_name,acceptor_bank_no,transferable,
          acceptance_date,remarks,inserted_at,updated_at
        FROM acc_bill WHERE id=${id}::uuid FOR UPDATE
      `.execute(db)
    : await sql<Record<string, unknown>>`
        SELECT id,bill_no,bill_kind,issue_date,due_date,face_amount,drawer_name,drawer_account,
          drawer_bank_name,drawer_bank_no,payee_name,payee_account,payee_bank_name,payee_bank_no,
          acceptor_name,acceptor_account,acceptor_bank_name,acceptor_bank_no,transferable,
          acceptance_date,remarks,inserted_at,updated_at
        FROM acc_bill WHERE id=${id}::uuid
      `.execute(db)
  if (!rows.rows[0]) throw notFound('承兑票据')
  return mapBill(rows.rows[0])
}

/** 薄 IO adapter：读已审核交易 → 纯核重放 → 整删整建 holding */
async function replayBill(trx: DbHandle, billId: string): Promise<void> {
  const bill = await loadBill(trx, billId, true)
  const rows = await sql<{
    id: string; doc_no: string | null; transaction_type: string; occurred_on: string
    sub_start: string; sub_end: string; company_id: string; bank_account_id: string
    to_bank_account_id: string | null
  }>`
    SELECT id,doc_no,transaction_type,occurred_on::text,sub_start::text,sub_end::text,
      company_id,bank_account_id,to_bank_account_id
    FROM acc_bill_transaction WHERE bill_id=${billId}::uuid AND status='audited'
    ORDER BY occurred_on,audited_at,id
  `.execute(trx)

  const txs: ReplayTx[] = rows.rows.map((row) => ({
    id: row.id,
    docNo: row.doc_no,
    transactionType: row.transaction_type,
    occurredOn: asDateOnly(row.occurred_on),
    subStart: Number(row.sub_start),
    subEnd: Number(row.sub_end),
    companyId: row.company_id,
    bankAccountId: row.bank_account_id,
    toBankAccountId: row.to_bank_account_id,
  }))
  const segments = replaySegments(txs)

  await sql`DELETE FROM acc_bill_holding WHERE bill_id=${billId}::uuid`.execute(trx)
  for (const segment of segments) {
    const amount = segmentAmount(segment.start, segment.end)
    await sql`
      INSERT INTO acc_bill_holding(
        bill_no,sub_start,sub_end,amount,due_date,acquired_on,company_id,
        bank_account_id,bill_id,source_transaction_id)
      VALUES (
        ${bill.billNo},${segment.start},${segment.end},${amount},
        ${bill.dueDate}::date,${segment.acquiredOn}::date,${segment.companyId}::uuid,
        ${segment.bankAccountId}::uuid,${billId}::uuid,${segment.sourceId}::uuid)
    `.execute(trx)
  }
}

function validateBillAttrs(attrs: BillAttrs): void {
  const kind = upper(attrs.billKind)
  const valid =
    kind === 'BANK_ACCEPTANCE' ||
    kind === 'COMMERCIAL_ACCEPTANCE' ||
    kind === 'FINANCE_COMPANY_ACCEPTANCE'
  if (!attrs.billNo.trim() || !valid || !attrs.dueDate.trim()) {
    throw ApiError.validation('票据主档参数不合法', { bill: ['票号、种类与到期日必填'] })
  }
  requireDate(attrs.dueDate, 'dueDate')
  if (attrs.faceAmount != null) parseDecimal(attrs.faceAmount, 'faceAmount', true, false)
}

async function registerBill(trx: DbHandle, attrs: BillAttrs): Promise<Bill> {
  validateBillAttrs(attrs)
  const existing = await sql<{ id: string }>`
    SELECT id FROM acc_bill WHERE bill_no=${attrs.billNo.trim()} FOR UPDATE
  `.execute(trx)
  if (existing.rows[0]) return loadBill(trx, existing.rows[0].id, false)
  const kind = lower(upper(attrs.billKind))
  const issue = attrs.issueDate ? requireDate(attrs.issueDate, 'issueDate') : null
  const due = requireDate(attrs.dueDate, 'dueDate')
  const acceptance = attrs.acceptanceDate ? requireDate(attrs.acceptanceDate, 'acceptanceDate') : null
  const transferable = attrs.transferable ?? true
  try {
    const ins = await sql<{ id: string }>`
      INSERT INTO acc_bill(
        bill_no,bill_kind,issue_date,due_date,face_amount,drawer_name,drawer_account,
        drawer_bank_name,drawer_bank_no,payee_name,payee_account,payee_bank_name,payee_bank_no,
        acceptor_name,acceptor_account,acceptor_bank_name,acceptor_bank_no,transferable,
        acceptance_date,remarks)
      VALUES (
        ${attrs.billNo.trim()},${kind},${issue}::date,${due}::date,${attrs.faceAmount ?? null},
        ${attrs.drawerName ?? null},${attrs.drawerAccount ?? null},${attrs.drawerBankName ?? null},
        ${attrs.drawerBankNo ?? null},${attrs.payeeName ?? null},${attrs.payeeAccount ?? null},
        ${attrs.payeeBankName ?? null},${attrs.payeeBankNo ?? null},${attrs.acceptorName ?? null},
        ${attrs.acceptorAccount ?? null},${attrs.acceptorBankName ?? null},${attrs.acceptorBankNo ?? null},
        ${transferable},${acceptance}::date,${attrs.remarks ?? null})
      RETURNING id
    `.execute(trx)
    return loadBill(trx, ins.rows[0]!.id, false)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw mapWriteError(err, '票据建档失败', WRITE_MAP)
  }
}

export type BillService = ReturnType<typeof createBillService>

export function createBillService(
  db: Kysely<Database>,
  numbering: NumberingService,
  deps: {
    gl: GlEngine
    files?: Pick<FileService, 'readReachableFile'> | null
    ocr?: OcrDeps
    /** 判定归宿解析（三个执行点共用） */
    registry: Registry
  },
) {
  const gl = deps.gl
  const files = deps.files ?? null
  const billTarget = deps.registry.authzTarget(BILL_RESOURCE)
  const billTxTarget = deps.registry.authzTarget(BILL_TRANSACTION_RESOURCE)
  const holdingTarget = deps.registry.authzTarget(BILL_HOLDING_RESOURCE)

  /**
   * 票据可见性谓词：票据自身无公司列（global），沿用「名下有本人可达交易」的既有语义。
   * 交易行的可达性由平台编译（`compileRowFilter`），模块不写公司分支。
   */
  function billVisibleWhere(permit: Permit, billAlias: string) {
    const txWhere = compileRowFilter(permit, billTxTarget, BILL_SCOPE_TX_ALIAS)
    return sql`EXISTS(
      SELECT 1 FROM acc_bill_transaction ${sql.raw(BILL_SCOPE_TX_ALIAS)}
      WHERE ${sql.raw(BILL_SCOPE_TX_ALIAS)}.bill_id=${sql.raw(billAlias)}.id AND ${txWhere}
    )`
  }

  /** 按 Permit 取票据主档（可锁）：票据码级判定 ∧ 名下有可达交易 */
  async function authorizedBill(
    handle: DbHandle, permit: Permit, id: string, forUpdate: boolean,
  ): Promise<Bill> {
    // 票据自身 global：loadAuthorized 只做码级 + 全局放行，可见性由交易派生
    const bill = await loadAuthorized({
      db: handle, permit, target: billTarget, table: BILL_TABLE, id, forUpdate,
      notFoundMessage: '承兑票据不存在',
    })
    const ok = await sql<{ e: boolean }>`
      SELECT ${billVisibleWhere(permit, 'acc_bill')} AS e FROM acc_bill WHERE id=${id}::uuid
    `.execute(handle)
    if (!ok.rows[0]?.e) throw notFound('承兑票据')
    return mapBill(bill)
  }

  async function listBills(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db, permit, target: billTarget, alias: BILL_TABLE,
      resource: BILL_META,
      source: sql` FROM acc_bill`,
      select: sql`SELECT id,bill_no,bill_kind,issue_date,due_date,face_amount,drawer_name,drawer_account,
        drawer_bank_name,drawer_bank_no,payee_name,payee_account,payee_bank_name,payee_bank_no,
        acceptor_name,acceptor_account,acceptor_bank_name,acceptor_bank_no,transferable,
        acceptance_date,remarks,inserted_at,updated_at`,
      defaultOrder: sql`"id"`, query,
      extraWhere: billVisibleWhere(permit, BILL_TABLE),
      mapRow: mapBill,
    })
  }

  async function getBill(permit: Permit, id: string) {
    return authorizedBill(db, permit, id, false)
  }

  async function updateBill(permit: Permit, id: string, input: Record<string, unknown>) {
    const actor = permit.actor
    return withTx(db, async (trx) => {
      const before = await authorizedBill(trx, permit, id, true)
      const attrs: BillAttrs = {
        billNo: before.billNo, billKind: before.billKind, issueDate: before.issueDate,
        dueDate: before.dueDate, faceAmount: before.faceAmount,
        drawerName: before.drawerName, drawerAccount: before.drawerAccount,
        drawerBankName: before.drawerBankName, drawerBankNo: before.drawerBankNo,
        payeeName: before.payeeName, payeeAccount: before.payeeAccount,
        payeeBankName: before.payeeBankName, payeeBankNo: before.payeeBankNo,
        acceptorName: before.acceptorName, acceptorAccount: before.acceptorAccount,
        acceptorBankName: before.acceptorBankName, acceptorBankNo: before.acceptorBankNo,
        transferable: before.transferable, acceptanceDate: before.acceptanceDate,
        remarks: before.remarks,
      }
      const set = (key: string, field: keyof BillAttrs) => {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          ;(attrs as unknown as Record<string, unknown>)[field] = input[key]
        }
      }
      if (input.billKind !== undefined) attrs.billKind = String(input.billKind)
      set('issueDate', 'issueDate')
      if (input.dueDate !== undefined) attrs.dueDate = String(input.dueDate)
      set('faceAmount', 'faceAmount')
      set('drawerName', 'drawerName'); set('drawerAccount', 'drawerAccount')
      set('drawerBankName', 'drawerBankName'); set('drawerBankNo', 'drawerBankNo')
      set('payeeName', 'payeeName'); set('payeeAccount', 'payeeAccount')
      set('payeeBankName', 'payeeBankName'); set('payeeBankNo', 'payeeBankNo')
      set('acceptorName', 'acceptorName'); set('acceptorAccount', 'acceptorAccount')
      set('acceptorBankName', 'acceptorBankName'); set('acceptorBankNo', 'acceptorBankNo')
      if (input.transferable !== undefined) attrs.transferable = Boolean(input.transferable)
      set('acceptanceDate', 'acceptanceDate'); set('remarks', 'remarks')
      validateBillAttrs(attrs)
      const hasTx = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM acc_bill_transaction WHERE bill_id=${id}::uuid) AS e
      `.execute(trx)
      if (hasTx.rows[0]?.e) {
        const faceEq =
          (attrs.faceAmount == null && before.faceAmount == null) ||
          (attrs.faceAmount != null && before.faceAmount != null &&
            decimal(attrs.faceAmount).eq(decimal(before.faceAmount)))
        if (
          attrs.dueDate !== before.dueDate ||
          !faceEq ||
          (attrs.transferable != null && attrs.transferable !== before.transferable)
        ) {
          throw conflict('票据已有交易,到期日、票面金额与能否转让不可修改')
        }
      }
      const kind = lower(upper(attrs.billKind))
      const issue = attrs.issueDate ? requireDate(String(attrs.issueDate), 'issueDate') : null
      const due = requireDate(attrs.dueDate, 'dueDate')
      const acceptance = attrs.acceptanceDate
        ? requireDate(String(attrs.acceptanceDate), 'acceptanceDate')
        : null
      const transferable = attrs.transferable ?? true
      try {
        await sql`
          UPDATE acc_bill SET bill_kind=${kind},issue_date=${issue}::date,due_date=${due}::date,
            face_amount=${attrs.faceAmount ?? null},drawer_name=${attrs.drawerName ?? null},
            drawer_account=${attrs.drawerAccount ?? null},drawer_bank_name=${attrs.drawerBankName ?? null},
            drawer_bank_no=${attrs.drawerBankNo ?? null},payee_name=${attrs.payeeName ?? null},
            payee_account=${attrs.payeeAccount ?? null},payee_bank_name=${attrs.payeeBankName ?? null},
            payee_bank_no=${attrs.payeeBankNo ?? null},acceptor_name=${attrs.acceptorName ?? null},
            acceptor_account=${attrs.acceptorAccount ?? null},acceptor_bank_name=${attrs.acceptorBankName ?? null},
            acceptor_bank_no=${attrs.acceptorBankNo ?? null},transferable=${transferable},
            acceptance_date=${acceptance}::date,remarks=${attrs.remarks ?? null},
            updated_at=(now() AT TIME ZONE 'utc') WHERE id=${id}::uuid
        `.execute(trx)
        const result = await loadBill(trx, id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bill', recordId: id, recordLabel: result.billNo,
          companyId: null, actionType: 'update', actionName: 'update',
          changes: auditDiff(billSnap(before), billSnap(result), BILL_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新承兑票据失败', WRITE_MAP)
      }
    })
  }

  async function deleteBill(permit: Permit, id: string) {
    const actor = permit.actor
    return withTx(db, async (trx) => {
      const before = await authorizedBill(trx, permit, id, true)
      const exists = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM acc_bill_transaction WHERE bill_id=${id}::uuid) AS e
      `.execute(trx)
      if (exists.rows[0]?.e) throw conflict('票据已有交易,不可删除')
      try {
        await sql`DELETE FROM acc_bill WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_bill', recordId: id, recordLabel: before.billNo,
          companyId: null, actionType: 'delete', actionName: 'delete',
          changes: auditDiff(billSnap(before), {}, BILL_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除承兑票据失败', WRITE_MAP)
      }
    })
  }

  async function validateTransaction(
    trx: DbHandle,
    input: {
      transactionType: string; companyId: string; bankAccountId: string
      billId: string; subStart: number; subEnd: number; amount: string
      occurredOn: string; postingDate?: string | null
      partyType?: string | null; partyId?: string | null
      discountOrg?: string | null; discountRate?: string | null
      interest?: string | null; netAmount?: string | null
      toBankAccountId?: string | null
    },
    bill: Bill,
    requireActive: boolean,
  ) {
    const type = upper(input.transactionType)
    if (
      !TYPES.has(type) || !input.companyId || !input.bankAccountId || !input.billId ||
      input.subStart < 1 || input.subEnd < input.subStart
    ) {
      throw ApiError.validation('承兑交易参数不合法', {
        transaction: ['类型、公司、账户、票据与子票段必须有效'],
      })
    }
    const occurredOn = requireDate(input.occurredOn, 'occurredOn')
    const amount = parseDecimal(input.amount, 'amount', true, false)
    if (!decimal(input.subEnd - input.subStart + 1).eq(amount.mul(100))) {
      throw ApiError.validation('承兑交易参数不合法', { subEnd: ['子票段长度必须等于金额×100'] })
    }
    if (bill.faceAmount != null) {
      const face = decimal(bill.faceAmount)
      if (decimal(input.subEnd).gt(face.mul(100))) {
        throw ApiError.validation('承兑交易参数不合法', { subEnd: ['子票段超出票面金额'] })
      }
    }
    const postingDate = input.postingDate ? requireDate(input.postingDate, 'postingDate') : null
    const banks = await sql<{ from_valid: boolean; to_valid: boolean }>`
      SELECT
        EXISTS(SELECT 1 FROM acc_bank_account WHERE id=${input.bankAccountId}::uuid
          AND company_id=${input.companyId}::uuid
          AND (${!requireActive} OR active)) AS from_valid,
        (${input.toBankAccountId ?? null}::uuid IS NULL OR EXISTS(
          SELECT 1 FROM acc_bank_account WHERE id=${input.toBankAccountId ?? null}::uuid
            AND company_id=${input.companyId}::uuid
            AND (${!requireActive} OR active))) AS to_valid
    `.execute(trx)
    if (!banks.rows[0]?.from_valid || !banks.rows[0]?.to_valid) {
      throw ApiError.validation('承兑交易参数不合法', {
        bankAccountId: ['银行账户不属于公司或已停用'],
      })
    }
    const requiresParty = type === 'RECEIVE' || type === 'ENDORSE'
    const hasParty = input.partyType != null && input.partyId != null
    if (requiresParty !== hasParty) {
      throw ApiError.validation('承兑交易参数不合法', {
        partyId: ['接收/转让必须填写对手,其他类型必须为空'],
      })
    }
    if (requiresParty) {
      const party = lower(upper(input.partyType!))
      const partyId = input.partyId!
      let exists = false
      if (party === 'supplier') {
        const r = await sql<{ e: boolean }>`SELECT EXISTS(SELECT 1 FROM pur_supplier WHERE id=${partyId}::uuid) AS e`.execute(trx)
        exists = Boolean(r.rows[0]?.e)
      } else if (party === 'customer') {
        const r = await sql<{ e: boolean }>`SELECT EXISTS(SELECT 1 FROM sal_customers WHERE id=${partyId}::uuid) AS e`.execute(trx)
        exists = Boolean(r.rows[0]?.e)
      } else if (party === 'company') {
        const r = await sql<{ e: boolean }>`SELECT EXISTS(SELECT 1 FROM bas_company WHERE id=${partyId}::uuid) AS e`.execute(trx)
        exists = Boolean(r.rows[0]?.e)
      } else if (party === 'employee') {
        const r = await sql<{ e: boolean }>`SELECT EXISTS(SELECT 1 FROM hr_employees WHERE id=${partyId}::uuid) AS e`.execute(trx)
        exists = Boolean(r.rows[0]?.e)
      }
      if (!exists) {
        throw ApiError.validation('承兑交易参数不合法', { partyId: ['对手不存在'] })
      }
    }
    let discountRate: string | null = null
    let interest: string | null = null
    let netAmount: string | null = null
    if (type === 'DISCOUNT') {
      if (
        !input.discountOrg?.trim() || !input.discountRate || !input.interest || !input.netAmount
      ) {
        throw ApiError.validation('承兑交易参数不合法', {
          discount: ['贴现机构、利率、利息与实收金额必填'],
        })
      }
      const rate = parseDecimal(input.discountRate, 'discountRate', false, true)
      const int = parseDecimal(input.interest, 'interest', false, true)
      const net = parseDecimal(input.netAmount, 'netAmount', true, false)
      if (!int.add(net).eq(amount)) {
        throw ApiError.validation('承兑交易参数不合法', {
          netAmount: ['交易金额必须等于贴现利息+实收金额'],
        })
      }
      discountRate = rate.toFixed()
      interest = int.toFixed()
      netAmount = net.toFixed()
    } else if (
      input.discountOrg != null || input.discountRate != null ||
      input.interest != null || input.netAmount != null
    ) {
      throw ApiError.validation('承兑交易参数不合法', {
        discount: ['非贴现交易不得填写贴现字段'],
      })
    }
    if (type === 'REALLOCATE') {
      if (!input.toBankAccountId || input.toBankAccountId === input.bankAccountId) {
        throw ApiError.validation('承兑交易参数不合法', {
          toBankAccountId: ['调拨须选择不同的同公司转入账户'],
        })
      }
    } else if (input.toBankAccountId != null) {
      throw ApiError.validation('承兑交易参数不合法', { toBankAccountId: ['仅调拨可填写'] })
    }
    return {
      type, occurredOn, amount: amount.toFixed(), postingDate,
      partyType: requiresParty ? upper(input.partyType!) : null,
      discountRate, interest, netAmount,
    }
  }

  function billTxEntries(value: BillTransaction): GlEntry[] {
    const amount = decimal(value.amount)
    const partyType = value.partyType ? lower(value.partyType) : ''
    switch (value.transactionType) {
      case 'RECEIVE':
        return [
          { accountId: value.billAccountId!, debit: amount, credit: '0' },
          {
            accountId: value.settleAccountId!, debit: '0', credit: amount,
            partyType, partyId: value.partyId,
          },
        ]
      case 'ENDORSE':
        return [
          {
            accountId: value.settleAccountId!, debit: amount, credit: '0',
            partyType, partyId: value.partyId,
          },
          { accountId: value.billAccountId!, debit: '0', credit: amount },
        ]
      case 'SETTLE':
        return [
          { accountId: value.settleAccountId!, debit: amount, credit: '0' },
          { accountId: value.billAccountId!, debit: '0', credit: amount },
        ]
      case 'DISCOUNT': {
        const net = decimal(value.netAmount!)
        const interestAmt = decimal(value.interest!)
        const result: GlEntry[] = [
          { accountId: value.settleAccountId!, debit: net, credit: '0' },
        ]
        if (interestAmt.gt(0)) {
          result.push({ accountId: value.interestAccountId!, debit: interestAmt, credit: '0' })
        }
        result.push({ accountId: value.billAccountId!, debit: '0', credit: amount })
        return result
      }
      default:
        throw conflict('调拨交易不生成总账分录')
    }
  }

  function validateBillAuditDate(tx: BillTransaction, bill: Bill) {
    if (tx.transactionType === 'SETTLE' && tx.occurredOn < bill.dueDate) {
      throw conflict('兑付发生日期不能早于票据到期日')
    }
    if (
      (tx.transactionType === 'RECEIVE' || tx.transactionType === 'ENDORSE' ||
        tx.transactionType === 'DISCOUNT') &&
      tx.occurredOn > bill.dueDate
    ) {
      throw conflict('接收/转让/贴现发生日期不能晚于票据到期日')
    }
    if (
      !bill.transferable &&
      (tx.transactionType === 'ENDORSE' || tx.transactionType === 'DISCOUNT')
    ) {
      throw conflict('该票据不得转让,禁止转让与贴现')
    }
  }

  /** 交易入参 → validateTransaction 的形状（create/update/审核三处共用） */
  function txShape(value: Record<string, unknown>) {
    return {
      transactionType: String(value.transactionType ?? ''),
      companyId: String(value.companyId ?? ''),
      bankAccountId: String(value.bankAccountId ?? ''),
      billId: String(value.billId ?? ''),
      subStart: Number(value.subStart),
      subEnd: Number(value.subEnd),
      amount: String(value.amount ?? ''),
      occurredOn: String(value.occurredOn ?? ''),
      postingDate: (value.postingDate as string | null | undefined) ?? null,
      partyType: (value.partyType as string | null | undefined) ?? null,
      partyId: (value.partyId as string | null | undefined) ?? null,
      discountOrg: (value.discountOrg as string | null | undefined) ?? null,
      discountRate: (value.discountRate as string | null | undefined) ?? null,
      interest: (value.interest as string | null | undefined) ?? null,
      netAmount: (value.netAmount as string | null | undefined) ?? null,
      toBankAccountId: (value.toBankAccountId as string | null | undefined) ?? null,
    }
  }

  const transactions = createStandardService<BillTransaction>({
    db,
    registry: deps.registry,
    resource: BILL_TRANSACTION_RESOURCE,
    notFound: '承兑交易不存在',
    defaultOrder: sql`"id"`,
    writeErrors: [...WRITE_MAP],
    hooks: {
      validate: ({ action, draft, before }) => {
        if (action === 'update' && before) {
          // 类型与公司不可变（迁移前 merged 直接取 before，入参静默忽略）
          draft.transactionType = before.transactionType
          draft.companyId = before.companyId
        }
      },
      beforeWrite: async (trx, { draft, before }) => {
        const bill = await loadBill(trx, String(draft.billId), true)
        const requireActive =
          draft.bankAccountId !== before!.bankAccountId ||
          (draft.toBankAccountId ?? null) !== (before!.toBankAccountId ?? null)
        const values = await validateTransaction(trx, txShape(draft), bill, requireActive)
        // 落库规范形（金额 toFixed / 日期切片 / 枚举大写；内核 toDbValue 再转小写）
        draft.occurredOn = values.occurredOn
        draft.amount = values.amount
        draft.partyType = values.partyType
        draft.discountRate = values.discountRate
        draft.interest = values.interest
        draft.netAmount = values.netAmount
        draft.postingDate = values.postingDate
      },
    },
    workflow: {
      mutableMessage: '仅草稿承兑交易可修改或删除',
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: '仅草稿承兑交易可审核',
          stamps: ({ permit }) => auditStamp(permit),
          effect: async (trx, { before, input }) => {
            const tx = before as BillTransaction
            // 调拨无过账日；其余类型必填（校验序同迁移前 collect：先过账日再票据）
            let posting: string | null = null
            if (tx.transactionType !== 'REALLOCATE') {
              const raw = (input.postingDate as string | null | undefined) ?? null
              if (!raw?.trim()) {
                throw ApiError.validation('承兑交易审核条件不完整', { postingDate: ['必填'] })
              }
              posting = requireDate(raw, 'postingDate')
            }
            const bill = await loadBill(trx, tx.billId, true)
            await validateTransaction(trx, txShape(tx), bill, false)
            if (tx.transactionType !== 'REALLOCATE') {
              if (
                !tx.billAccountId || !tx.settleAccountId ||
                (tx.transactionType === 'DISCOUNT' && tx.interest != null &&
                  decimal(tx.interest).gt(0) && !tx.interestAccountId)
              ) {
                throw ApiError.validation('承兑交易审核条件不完整', {
                  posting: ['过账日期及所需科目必填'],
                })
              }
            }
            validateBillAuditDate(tx, bill)
            // 调拨不生成总账分录（skipGl 的内核等价物：effect 直接不调引擎）
            if (tx.transactionType !== 'REALLOCATE') {
              await gl.post(
                trx,
                {
                  type: VOUCHER,
                  id: tx.id,
                  no: txLabel(tx),
                  companyId: tx.companyId,
                  postingDate: posting!,
                },
                billTxEntries(tx),
              )
            }
            // 过账日随状态翻转落库（调拨写 NULL，口径同迁移前）
            return { posting_date: posting }
          },
          // 重放必须看到翻转后的状态：挂 after（翻转 + 审计之后，仍在同事务）
          after: async (trx, { before }) => {
            await replayBill(trx, String((before as BillTransaction).billId))
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: '仅已审核承兑交易可作废',
          effect: async (trx, { before }) => {
            const tx = before as BillTransaction
            await loadBill(trx, tx.billId, true)
            if (tx.transactionType !== 'REALLOCATE') {
              await gl.cancel(trx, { type: VOUCHER, id: tx.id })
            }
          },
          after: async (trx, { before }) => {
            await replayBill(trx, String((before as BillTransaction).billId))
          },
        },
      ],
    },
  })

  /**
   * 建交易（手写）：RECEIVE 可携 billAttrs 联动建票据主档（非本资源字段，
   * 内核 normalizeInput 会丢弃），取号 values 亦按发生日而非过账日。
   */
  async function createTransaction(permit: Permit, input: {
    docNo?: string | null; transactionType: string; occurredOn: string
    subStart: number; subEnd: number; amount: string
    partyType?: string | null; partyId?: string | null
    discountOrg?: string | null; discountRate?: string | null
    interest?: string | null; netAmount?: string | null
    postingDate?: string | null; remarks?: string | null
    companyId: string; bankAccountId: string; toBankAccountId?: string | null
    billId?: string | null; billAttrs?: BillAttrs | null
    billAccountId?: string | null; settleAccountId?: string | null
    interestAccountId?: string | null
  }): Promise<BillTransaction> {
    const actor = permit.actor
    assertCompanyWritable(permit, input.companyId, '承兑交易不存在')
    return withTx(db, async (trx) => {
      const type = upper(input.transactionType)
      let billId = input.billId ?? null
      if (type === 'RECEIVE') {
        if ((billId == null) === (input.billAttrs == null)) {
          throw ApiError.validation('承兑交易参数不合法', {
            bill: ['接收交易须且仅须传 billId 或 billAttrs'],
          })
        }
        if (!billId && input.billAttrs) {
          const bill = await registerBill(
            trx,
            normalizeBillAttrs(input.billAttrs as unknown as Record<string, unknown>),
          )
          billId = bill.id
        }
      } else if (!billId || input.billAttrs != null) {
        throw ApiError.validation('承兑交易参数不合法', {
          billId: ['非接收交易必须填写 billId'],
        })
      }
      const bill = await loadBill(trx, billId!, true)
      const values = await validateTransaction(trx, {
        transactionType: type, companyId: input.companyId, bankAccountId: input.bankAccountId,
        billId: billId!, subStart: input.subStart, subEnd: input.subEnd, amount: input.amount,
        occurredOn: input.occurredOn, postingDate: input.postingDate,
        partyType: input.partyType, partyId: input.partyId,
        discountOrg: input.discountOrg, discountRate: input.discountRate,
        interest: input.interest, netAmount: input.netAmount,
        toBankAccountId: input.toBankAccountId,
      }, bill, true)
      let docNo = (input.docNo ?? '').trim()
      if (!docNo) {
        docNo = await numbering.nextInTx(trx, {
          resource: 'acc.bill_transaction',
          values: { company_id: input.companyId, posting_date: values.occurredOn },
        })
      }
      try {
        const ins = await sql<Record<string, unknown>>`
          INSERT INTO acc_bill_transaction(
            doc_no,transaction_type,occurred_on,sub_start,sub_end,amount,party_type,party_id,
            discount_org,discount_rate,interest,net_amount,posting_date,remarks,company_id,
            bank_account_id,to_bank_account_id,bill_id,bill_account_id,settle_account_id,
            interest_account_id,created_by_id)
          VALUES (
            ${docNo},${lower(values.type)},${values.occurredOn}::date,${input.subStart},${input.subEnd},
            ${values.amount},${values.partyType ? lower(values.partyType) : null},
            ${input.partyId ?? null}::uuid,${input.discountOrg ?? null},${values.discountRate},
            ${values.interest},${values.netAmount},${values.postingDate}::date,${input.remarks ?? null},
            ${input.companyId}::uuid,${input.bankAccountId}::uuid,${input.toBankAccountId ?? null}::uuid,
            ${billId}::uuid,${input.billAccountId ?? null}::uuid,${input.settleAccountId ?? null}::uuid,
            ${input.interestAccountId ?? null}::uuid,${actorUserId(actor)}::uuid)
          RETURNING *
        `.execute(trx)
        const result = mapRow(TX_META, ins.rows[0]!) as BillTransaction
        await writeAudit(trx, actor, {
          resource: BILL_TX_TABLE, recordId: result.id, recordLabel: docNo,
          companyId: result.companyId, actionType: 'create', actionName: 'create',
          changes: auditCreated(snapshot(TX_META, result, TX_AUDIT), TX_AUDIT),
        })
        return result
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建承兑交易失败', WRITE_MAP)
      }
    })
  }

  /** 审核：过账日期的必填/格式校验在 effect 内（状态门之后，与迁移前 collect 同序） */
  async function auditTransaction(permit: Permit, id: string, postingDate?: string | null) {
    return transactions.transition(permit, id, 'audit', { postingDate: postingDate ?? null })
  }

  async function listHoldings(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db, permit, target: holdingTarget, alias: BILL_HOLDING_TABLE,
      resource: billHoldingResourceMeta(),
      source: sql` FROM acc_bill_holding`,
      select: sql`SELECT id,bill_no,sub_start,sub_end,amount,due_date,acquired_on,inserted_at,
        company_id,bank_account_id,bill_id,source_transaction_id`,
      defaultOrder: sql`"id"`, query, mapRow: mapHolding,
    })
  }

  async function getHolding(permit: Permit, id: string) {
    const row = await loadAuthorized({
      db, permit, target: holdingTarget, table: BILL_HOLDING_TABLE, id,
      notFoundMessage: '持有承兑不存在',
    })
    return mapHolding(row)
  }

  async function ocrBill(permit: Permit, fileId: string): Promise<OcrPrefill> {
    if (!files) {
      throw ApiError.validation('OCR 未配置', { fileId: ['文件服务未配置'] })
    }
    // 文件可达性归平台判定（码 forbidden / 行级 not_found），本域不再自造闸
    const { file, content } = await files.readReachableFile(permit.actor, fileId)
    return recognizeBankAcceptance(db, file, content, deps.ocr)
  }

  return {
    listBills, getBill, updateBill, deleteBill,
    listTransactions: (permit: Permit, query: Partial<ListQuery>) => transactions.list(permit, query),
    getTransaction: (permit: Permit, id: string) => transactions.get(permit, id),
    createTransaction,
    updateTransaction: (permit: Permit, id: string, patch: Record<string, unknown>) =>
      transactions.update(permit, id, patch),
    deleteTransaction: (permit: Permit, id: string) => transactions.remove(permit, id),
    auditTransaction,
    voidTransaction: (permit: Permit, id: string) => transactions.transition(permit, id, 'void'),
    listHoldings, getHolding, ocrBill,
  }
}

function txLabel(t: BillTransaction): string {
  return t.docNo && t.docNo !== '' ? t.docNo : t.id
}
