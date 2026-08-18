/**
 * 银行对账 + 快速对账凭证。
 *
 * 对账对象是总账来源单据（voucher_type + voucher_id），容量取未作废分录上
 * 银行科目对应方向的合计。快速对账仍建手工凭证再挂同一套多态引用。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { JournalService } from '~/modules/accounting/journal-service.ts'
import {
  auditCreated, auditDestroyed, writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized } from '~/db/load.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { reconcileStatus, txnAmount, type BankTransaction } from './banking-shared.ts'
import {
  asIso, conflict, lower, notFound,
  validateOptionalText, validation, wireDecRequired,
} from './common.ts'
import { bankReconciliationResourceMeta } from './meta.ts'

export const BANK_RECONCILIATION_RESOURCE = 'accBankReconciliations'
const RECON_TABLE = 'acc_bank_reconciliation'
export const JOURNAL_VOUCHER = 'acc.gl_journal'
export const BILL_TX_VOUCHER = 'acc.bill_transaction'

export interface BankReconciliation {
  id: string; amount: string; insertedAt: string; updatedAt: string
  companyId: string; bankTransactionId: string
  voucherType: string; voucherId: string; voucherNo: string
  /** 来源为手工凭证时等于 voucherId，便于旧调用方；否则 null */
  journalId: string | null
}

export interface SourceVoucher {
  type: string
  id: string
}

const RECON_AUDIT = auditFieldsOf(bankReconciliationResourceMeta())
const WRITE_MAP = [
  { code: '23505', message: '银行业务记录冲突' },
  { code: '23503', message: '银行业务引用不存在' },
] as const

function mapRecon(row: Record<string, unknown>): BankReconciliation {
  const voucherType = String(row.voucher_type)
  const voucherId = String(row.voucher_id)
  return {
    id: String(row.id), amount: wireDecRequired(row.amount),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), bankTransactionId: String(row.bank_transaction_id),
    voucherType, voucherId, voucherNo: String(row.voucher_no),
    journalId: voucherType === JOURNAL_VOUCHER ? voucherId : null,
  }
}

function reconSnap(r: BankReconciliation): Record<string, unknown> {
  return {
    amount: r.amount, company_id: r.companyId,
    bank_transaction_id: r.bankTransactionId,
    voucher_type: r.voucherType, voucher_id: r.voucherId, voucher_no: r.voucherNo,
  }
}

const RECON_SELECT = sql`
  SELECT id,amount,inserted_at,updated_at,company_id,bank_transaction_id,
    voucher_type,voucher_id,voucher_no
`

async function loadRecon(db: DbHandle, id: string, lock: boolean): Promise<BankReconciliation> {
  const rows = await sql<Record<string, unknown>>`
    ${RECON_SELECT}
    FROM acc_bank_reconciliation WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('银行对账记录')
  return mapRecon(rows.rows[0])
}

async function bankLedgerAccount(db: DbHandle, transaction: BankTransaction, share = false): Promise<string> {
  const rows = await sql<{ account_id: string | null }>`
    SELECT account_id FROM acc_bank_account WHERE id=${transaction.bankAccountId}::uuid
    ${share ? sql`FOR SHARE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('银行账户')
  if (rows.rows[0].account_id == null) {
    throw validation('银行对账', { bankTransactionId: ['银行账户未绑定会计科目'] })
  }
  return rows.rows[0].account_id
}

/** 流水已对账金额合计（只读接缝；账户/流水侧不得直查对账表）。 */
export async function reconciledTotalForTransaction(
  db: DbHandle,
  transactionId: string,
) {
  const rows = await sql<{ s: string }>`
    SELECT COALESCE(sum(amount),0)::text AS s FROM acc_bank_reconciliation
    WHERE bank_transaction_id=${transactionId}::uuid
  `.execute(db)
  return decimal(rows.rows[0]?.s ?? '0')
}

async function reconciledTotal(db: DbHandle, transactionId: string) {
  return reconciledTotalForTransaction(db, transactionId)
}

async function voucherCapacity(
  db: DbHandle, voucher: SourceVoucher, ledgerAccountId: string, income: boolean,
): Promise<{ total: ReturnType<typeof decimal>; used: ReturnType<typeof decimal>; voucherNo: string; companyId: string }> {
  const column = income ? 'debit' : 'credit'
  const totalRows = await sql<{ s: string; voucher_no: string; company_id: string }>`
    SELECT COALESCE(sum(${sql.raw(column)}),0)::text AS s,
           min(voucher_no) AS voucher_no, min(company_id::text) AS company_id
    FROM acc_gl_entry
    WHERE voucher_type=${voucher.type} AND voucher_id=${voucher.id}::uuid
      AND account_id=${ledgerAccountId}::uuid AND is_cancelled=false
  `.execute(db)
  const usedRows = await sql<{ s: string }>`
    SELECT COALESCE(sum(r.amount),0)::text AS s
    FROM acc_bank_reconciliation r
    JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
    JOIN acc_bank_account b ON b.id=t.bank_account_id
    WHERE r.voucher_type=${voucher.type} AND r.voucher_id=${voucher.id}::uuid
      AND b.account_id=${ledgerAccountId}::uuid
      AND ((${income} AND t.income IS NOT NULL) OR (NOT ${income} AND t.expense IS NOT NULL))
  `.execute(db)
  return {
    total: decimal(totalRows.rows[0]?.s ?? '0'),
    used: decimal(usedRows.rows[0]?.s ?? '0'),
    voucherNo: totalRows.rows[0]?.voucher_no ?? '',
    companyId: totalRows.rows[0]?.company_id ?? '',
  }
}

async function refreshBankTransaction(db: DbHandle, transaction: BankTransaction): Promise<void> {
  const total = await reconciledTotal(db, transaction.id)
  const amount = txnAmount(transaction.income, transaction.expense)
  const remaining = amount.sub(total)
  const status = lower(reconcileStatus(total, amount))
  const result = await sql`
    UPDATE acc_bank_transaction SET
      reconciled_amount=${total.toFixed()}, unreconciled_amount=${remaining.toFixed()},
      reconcile_status=${status}, updated_at=timezone('utc',now())
    WHERE id=${transaction.id}::uuid
  `.execute(db)
  if (result.numAffectedRows !== 1n && Number(result.numAffectedRows) !== 1) {
    throw conflict('银行流水已被并发删除')
  }
}

export async function isJournalLinkedToBankRecon(
  db: DbHandle,
  journalId: string,
): Promise<boolean> {
  return isVoucherLinkedToBankRecon(db, JOURNAL_VOUCHER, journalId)
}

export async function isVoucherLinkedToBankRecon(
  db: DbHandle,
  voucherType: string,
  voucherId: string,
): Promise<boolean> {
  const used = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM acc_bank_reconciliation
      WHERE voucher_type=${voucherType} AND voucher_id=${voucherId}::uuid
    ) AS e
  `.execute(db)
  return Boolean(used.rows[0]?.e)
}

/** 流水是否已有对账记录（删除前闸；账户/流水侧只读接缝）。 */
export async function hasReconForTransaction(
  db: DbHandle,
  transactionId: string,
): Promise<boolean> {
  const used = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM acc_bank_reconciliation WHERE bank_transaction_id=${transactionId}::uuid
    ) AS e
  `.execute(db)
  return Boolean(used.rows[0]?.e)
}

/** 银行账户名下流水是否存在对账记录（更换绑定科目前闸）。 */
export async function hasReconForBankAccount(
  db: DbHandle,
  bankAccountId: string,
): Promise<boolean> {
  const used = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM acc_bank_reconciliation r
      JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
      WHERE t.bank_account_id=${bankAccountId}::uuid
    ) AS e
  `.execute(db)
  return Boolean(used.rows[0]?.e)
}

export function resolveSourceVoucher(input: {
  journalId?: string | null
  voucherType?: string | null
  voucherId?: string | null
}): SourceVoucher {
  if (input.voucherId?.trim()) {
    return { type: (input.voucherType?.trim() || JOURNAL_VOUCHER), id: input.voucherId.trim() }
  }
  if (input.journalId?.trim()) {
    return { type: JOURNAL_VOUCHER, id: input.journalId.trim() }
  }
  throw validation('银行对账', { voucherId: ['须指定来源单据'] })
}

export function createReconOps(
  db: Kysely<Database>,
  registry: Registry,
  deps: {
    journals: Pick<JournalService, 'createAndAuditJournal'>
    /** 流水的授权入口（banking-accounts 注入，全模块共用同一份 loadAuthorized 参数） */
    authorizedTransaction: (
      handle: DbHandle, permit: Permit, id: string, forUpdate: boolean,
    ) => Promise<BankTransaction>
  },
) {
  const { journals, authorizedTransaction } = deps
  const reconTarget = registry.authzTarget(BANK_RECONCILIATION_RESOURCE)

  async function listReconciliations(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db, permit, target: reconTarget, alias: RECON_TABLE,
      resource: bankReconciliationResourceMeta(),
      source: sql` FROM acc_bank_reconciliation`,
      select: sql`SELECT id,amount,inserted_at,updated_at,company_id,bank_transaction_id,
        voucher_type,voucher_id,voucher_no`,
      defaultOrder: sql`"id"`, query, mapRow: mapRecon,
    })
  }

  async function getReconciliation(permit: Permit, id: string) {
    const row = await loadAuthorized({
      db, permit, target: reconTarget, table: RECON_TABLE, id,
      notFoundMessage: '银行对账记录不存在',
    })
    return mapRecon(row)
  }

  async function lockSource(trx: DbHandle, voucher: SourceVoucher): Promise<void> {
    if (voucher.type === JOURNAL_VOUCHER) {
      const rows = await sql<{ id: string; status: string }>`
        SELECT id,status FROM acc_gl_journal WHERE id=${voucher.id}::uuid FOR UPDATE
      `.execute(trx)
      const journal = rows.rows[0]
      if (!journal) throw validation('银行对账', { voucherId: ['会计凭证不存在'] })
      if (journal.status !== 'audited') {
        throw validation('银行对账', { voucherId: ['仅已审核凭证可用于对账'] })
      }
      return
    }
    if (voucher.type === BILL_TX_VOUCHER) {
      const rows = await sql<{ id: string; status: string }>`
        SELECT id,status FROM acc_bill_transaction WHERE id=${voucher.id}::uuid FOR UPDATE
      `.execute(trx)
      const tx = rows.rows[0]
      if (!tx) throw validation('银行对账', { voucherId: ['承兑交易不存在'] })
      if (tx.status !== 'audited') {
        throw validation('银行对账', { voucherId: ['仅已审核承兑交易可用于对账'] })
      }
    }
  }

  async function createReconciliationLocked(
    trx: DbHandle, permit: Permit, transaction: BankTransaction,
    voucher: SourceVoucher, amountStr: string,
  ): Promise<BankReconciliation> {
    const actor = permit.actor
    const ledgerAccountId = await bankLedgerAccount(trx, transaction, true)
    await lockSource(trx, voucher)
    const amount = decimal(amountStr)
    if (!amount.gt(0)) throw validation('银行对账', { amount: ['对账金额必须大于零'] })
    const income = transaction.income != null
    const cap = await voucherCapacity(trx, voucher, ledgerAccountId, income)
    if (!cap.companyId) {
      throw validation('银行对账', { voucherId: ['来源单据不存在或尚未过账'] })
    }
    if (cap.companyId !== transaction.companyId) {
      throw validation('银行对账', { voucherId: ['凭证与流水必须属于同一公司'] })
    }
    const sideLabel = income ? '借方' : '贷方'
    if (!cap.total.gt(0)) {
      throw validation('银行对账', {
        voucherId: [`凭证不含该银行科目的${sideLabel}分录行,方向不匹配`],
      })
    }
    const txnUsed = await reconciledTotal(trx, transaction.id)
    const txnRemaining = txnAmount(transaction.income, transaction.expense).sub(txnUsed)
    if (amount.gt(txnRemaining)) {
      throw validation('银行对账', {
        amount: [`超过流水未对账金额(剩余 ${txnRemaining.toFixed()})`],
      })
    }
    const journalRemaining = cap.total.sub(cap.used)
    if (amount.gt(journalRemaining)) {
      throw validation('银行对账', {
        amount: [`超过凭证可对账余额(该科目${sideLabel}剩余 ${journalRemaining.toFixed()})`],
      })
    }
    try {
      const ins = await sql<{ id: string }>`
        INSERT INTO acc_bank_reconciliation(
          amount,company_id,bank_transaction_id,voucher_type,voucher_id,voucher_no)
        VALUES (
          ${amount.toFixed()},${transaction.companyId}::uuid,${transaction.id}::uuid,
          ${voucher.type},${voucher.id}::uuid,${cap.voucherNo})
        RETURNING id
      `.execute(trx)
      await refreshBankTransaction(trx, transaction)
      const item = await loadRecon(trx, ins.rows[0]!.id, false)
      await writeAudit(trx, actor, {
        resource: 'acc_bank_reconciliation', recordId: item.id,
        recordLabel: `${item.bankTransactionId}/${item.voucherNo}`,
        companyId: item.companyId, actionType: 'create', actionName: 'create',
        changes: auditCreated(reconSnap(item), RECON_AUDIT),
      })
      return item
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建银行对账记录失败', WRITE_MAP)
    }
  }

  async function createReconciliation(permit: Permit, input: {
    bankTransactionId: string; amount: string
    journalId?: string | null
    voucherType?: string | null
    voucherId?: string | null
  }) {
    return withTx(db, async (trx) => {
      const transaction = await authorizedTransaction(trx, permit, input.bankTransactionId, true)
      return createReconciliationLocked(
        trx, permit, transaction, resolveSourceVoucher(input), input.amount,
      )
    })
  }

  async function remaining(permit: Permit, bankTransactionId: string, voucher: SourceVoucher) {
    const transaction = await authorizedTransaction(db, permit, bankTransactionId, false)
    const ledgerAccountId = await bankLedgerAccount(db, transaction, false)
    const txnUsed = await reconciledTotal(db, transaction.id)
    const cap = await voucherCapacity(
      db, voucher, ledgerAccountId, transaction.income != null,
    )
    if (cap.companyId && cap.companyId !== transaction.companyId) {
      throw notFound('银行流水或凭证')
    }
    let journalRemaining = cap.total.sub(cap.used)
    if (journalRemaining.isNegative()) journalRemaining = decimal(0)
    const txnRemaining = txnAmount(transaction.income, transaction.expense).sub(txnUsed)
    const result = txnRemaining.lt(journalRemaining) ? txnRemaining : journalRemaining
    return { amount: result.toFixed() }
  }

  /**
   * 快速对账凭证：借贷两行，经 accounting 窄 seam 在同一 trx 内建立并审核。
   * 凭证生命周期（编号/审计/状态机/GL）归 journal-service 唯一实现，此处不再复制。
   * 权限：端点已由 guard 判过 acc.bank_transaction:reconcile；
   * createAndAuditJournal 为无闸 seam，不在此叠 gl_journal:create/audit。
   */
  async function createQuickJournal(
    trx: TrxHandle, permit: Permit, input: {
      companyId: string; bankLedgerAccountId: string; counterAccountId: string
      income: boolean; amount: ReturnType<typeof decimal>; summary: string | null; postingDate: string
    },
  ): Promise<string> {
    const amount = input.amount
    const lines = input.income
      ? [
          { accountId: input.bankLedgerAccountId, debit: amount, credit: decimal(0), remarks: input.summary },
          { accountId: input.counterAccountId, debit: decimal(0), credit: amount, remarks: input.summary },
        ]
      : [
          { accountId: input.counterAccountId, debit: amount, credit: decimal(0), remarks: input.summary },
          { accountId: input.bankLedgerAccountId, debit: decimal(0), credit: amount, remarks: input.summary },
        ]
    const journal = await journals.createAndAuditJournal(trx, permit.actor, {
      companyId: input.companyId,
      date: input.postingDate,
      postingDate: input.postingDate,
      remarks: input.summary,
      lines,
    })
    return journal.id
  }

  async function quickCreate(permit: Permit, input: {
    bankTransactionId: string; counterAccountId: string; amount: string
    summary?: string | null; postingDate: string
  }) {
    const fields: Record<string, string[]> = {}
    const amount = decimal(input.amount)
    if (!amount.gt(0)) fields.amount = ['对账金额必须大于零']
    if (!input.postingDate) fields.postingDate = ['必填']
    validateOptionalText(fields, 'summary', input.summary, 255)
    if (Object.keys(fields).length) throw validation('快速对账', fields)
    return withTx(db, async (trx) => {
      const transaction = await authorizedTransaction(trx, permit, input.bankTransactionId, true)
      const ledgerAccountId = await bankLedgerAccount(trx, transaction, true)
      if (input.counterAccountId === ledgerAccountId) {
        throw validation('快速对账', { counterAccountId: ['对方科目不能是银行账户绑定的科目'] })
      }
      const acc = await sql<{ company_id: string; active: boolean; is_group: boolean }>`
        SELECT company_id,active,is_group FROM bas_account WHERE id=${input.counterAccountId}::uuid
      `.execute(trx)
      const row = acc.rows[0]
      if (!row) throw validation('快速对账', { counterAccountId: ['科目不存在'] })
      if (row.company_id !== transaction.companyId || !row.active || row.is_group) {
        throw validation('快速对账', { counterAccountId: ['科目须属于同一公司、启用且非汇总科目'] })
      }
      const used = await reconciledTotal(trx, transaction.id)
      const remainingAmt = txnAmount(transaction.income, transaction.expense).sub(used)
      if (amount.gt(remainingAmt)) {
        throw validation('快速对账', { amount: [`超过流水未对账金额(剩余 ${remainingAmt.toFixed()})`] })
      }
      const journalId = await createQuickJournal(trx, permit, {
        companyId: transaction.companyId,
        bankLedgerAccountId: ledgerAccountId,
        counterAccountId: input.counterAccountId,
        income: transaction.income != null,
        amount, summary: input.summary ?? null, postingDate: input.postingDate,
      })
      return createReconciliationLocked(
        trx, permit, transaction, { type: JOURNAL_VOUCHER, id: journalId }, amount.toFixed(),
      )
    })
  }

  async function deleteReconciliation(permit: Permit, id: string) {
    const actor = permit.actor
    return withTx(db, async (trx) => {
      const seed = await loadRecon(trx, id, false)
      const transaction = await authorizedTransaction(trx, permit, seed.bankTransactionId, true)
      const item = await loadRecon(trx, id, true)
      if (item.bankTransactionId !== transaction.id) throw conflict('银行对账记录已被并发修改')
      try {
        await sql`DELETE FROM acc_bank_reconciliation WHERE id=${id}::uuid`.execute(trx)
        await refreshBankTransaction(trx, transaction)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_reconciliation', recordId: id,
          recordLabel: `${item.bankTransactionId}/${item.voucherNo}`,
          companyId: item.companyId, actionType: 'destroy', actionName: 'destroy',
          changes: auditDestroyed(reconSnap(item), RECON_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '解除银行对账失败', WRITE_MAP)
      }
    })
  }

  return {
    listReconciliations, getReconciliation, createReconciliation,
    remaining, quickCreate, deleteReconciliation,
  }
}
