/**
 * 银行对账 + 快速对账凭证。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine, type GlEngine, type GlEntry } from '~/engines/gl/index.ts'
import {
  auditCreated, auditDestroyed, writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { companyScopeWhere, listFromSource } from '../base/list.ts'
import { mapWriteError } from '../base/dberr.ts'
import {
  loadTransaction, reconcileStatus, txnAmount, type BankTransaction,
} from './banking-accounts.ts'
import {
  actorUserId, asIso, conflict, lower, notFound, requireCompanyAccess,
  requirePerm, validateOptionalText, validation, wireDecRequired,
} from './common.ts'
import { bankReconciliationResourceMeta } from './meta.ts'

export interface BankReconciliation {
  id: string; amount: string; insertedAt: string; updatedAt: string
  companyId: string; bankTransactionId: string; journalId: string
}

const RECON_AUDIT = ['amount', 'company_id', 'bank_transaction_id', 'journal_id'] as const
const WRITE_MAP = [
  { code: '23505', message: '银行业务记录冲突' },
  { code: '23503', message: '银行业务引用不存在' },
] as const

function mapRecon(row: Record<string, unknown>): BankReconciliation {
  return {
    id: String(row.id), amount: wireDecRequired(row.amount),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), bankTransactionId: String(row.bank_transaction_id),
    journalId: String(row.journal_id),
  }
}

function reconSnap(r: BankReconciliation): Record<string, unknown> {
  return {
    amount: r.amount, company_id: r.companyId,
    bank_transaction_id: r.bankTransactionId, journal_id: r.journalId,
  }
}

async function loadRecon(db: DbHandle, id: string, lock: boolean): Promise<BankReconciliation> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,amount,inserted_at,updated_at,company_id,bank_transaction_id,journal_id
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

async function reconciledTotal(db: DbHandle, transactionId: string) {
  const rows = await sql<{ s: string }>`
    SELECT COALESCE(sum(amount),0)::text AS s FROM acc_bank_reconciliation
    WHERE bank_transaction_id=${transactionId}::uuid
  `.execute(db)
  return decimal(rows.rows[0]?.s ?? '0')
}

async function journalCapacity(
  db: DbHandle, journalId: string, ledgerAccountId: string, income: boolean,
): Promise<{ total: ReturnType<typeof decimal>; used: ReturnType<typeof decimal> }> {
  const column = income ? 'debit' : 'credit'
  const totalRows = await sql<{ s: string }>`
    SELECT COALESCE(sum(${sql.raw(column)}),0)::text AS s
    FROM acc_gl_journal_line WHERE journal_id=${journalId}::uuid AND account_id=${ledgerAccountId}::uuid
  `.execute(db)
  const usedRows = await sql<{ s: string }>`
    SELECT COALESCE(sum(r.amount),0)::text AS s
    FROM acc_bank_reconciliation r
    JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
    JOIN acc_bank_account b ON b.id=t.bank_account_id
    WHERE r.journal_id=${journalId}::uuid AND b.account_id=${ledgerAccountId}::uuid
      AND ((${income} AND t.income IS NOT NULL) OR (NOT ${income} AND t.expense IS NOT NULL))
  `.execute(db)
  return {
    total: decimal(totalRows.rows[0]?.s ?? '0'),
    used: decimal(usedRows.rows[0]?.s ?? '0'),
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

export function createReconOps(
  db: Kysely<Database>,
  numbering: NumberingService,
  gl: GlEngine = createGlEngine(),
) {
  async function listReconciliations(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'acc.bank_transaction:read', '无权限执行银行业务操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as BankReconciliation[] }
    return listFromSource({
      db, resource: bankReconciliationResourceMeta(),
      source: sql` FROM acc_bank_reconciliation`,
      select: sql`SELECT id,amount,inserted_at,updated_at,company_id,bank_transaction_id,journal_id`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapRecon,
    })
  }

  async function getReconciliation(actor: Actor, id: string) {
    requirePerm(actor, 'acc.bank_transaction:read', '无权限执行银行业务操作')
    const item = await loadRecon(db, id, false)
    requireCompanyAccess(actor, item.companyId, '银行对账记录')
    return item
  }

  async function createReconciliationLocked(
    trx: DbHandle, actor: Actor, transaction: BankTransaction, journalId: string, amountStr: string,
  ): Promise<BankReconciliation> {
    const ledgerAccountId = await bankLedgerAccount(trx, transaction, true)
    const journalRows = await sql<{ id: string; status: string; company_id: string }>`
      SELECT id,status,company_id FROM acc_gl_journal WHERE id=${journalId}::uuid FOR UPDATE
    `.execute(trx)
    const journal = journalRows.rows[0]
    if (!journal) throw validation('银行对账', { journalId: ['会计凭证不存在'] })
    const amount = decimal(amountStr)
    if (!amount.gt(0)) throw validation('银行对账', { amount: ['对账金额必须大于零'] })
    if (journal.company_id !== transaction.companyId) {
      throw validation('银行对账', { journalId: ['凭证与流水必须属于同一公司'] })
    }
    if (journal.status !== 'audited') {
      throw validation('银行对账', { journalId: ['仅已审核凭证可用于对账'] })
    }
    const txnUsed = await reconciledTotal(trx, transaction.id)
    const income = transaction.income != null
    const { total: lineTotal, used: journalUsed } = await journalCapacity(
      trx, journal.id, ledgerAccountId, income,
    )
    const sideLabel = income ? '借方' : '贷方'
    if (!lineTotal.gt(0)) {
      throw validation('银行对账', {
        journalId: [`凭证不含该银行科目的${sideLabel}分录行,方向不匹配`],
      })
    }
    const txnRemaining = txnAmount(transaction.income, transaction.expense).sub(txnUsed)
    if (amount.gt(txnRemaining)) {
      throw validation('银行对账', {
        amount: [`超过流水未对账金额(剩余 ${txnRemaining.toFixed()})`],
      })
    }
    const journalRemaining = lineTotal.sub(journalUsed)
    if (amount.gt(journalRemaining)) {
      throw validation('银行对账', {
        amount: [`超过凭证可对账余额(该科目${sideLabel}剩余 ${journalRemaining.toFixed()})`],
      })
    }
    try {
      const ins = await sql<{ id: string }>`
        INSERT INTO acc_bank_reconciliation(amount,company_id,bank_transaction_id,journal_id)
        VALUES (${amount.toFixed()},${transaction.companyId}::uuid,${transaction.id}::uuid,${journal.id}::uuid)
        RETURNING id
      `.execute(trx)
      await refreshBankTransaction(trx, transaction)
      const item = await loadRecon(trx, ins.rows[0]!.id, false)
      await writeAudit(trx, actor, {
        resource: 'acc_bank_reconciliation', recordId: item.id,
        recordLabel: `${item.bankTransactionId}/${item.journalId}`,
        companyId: item.companyId, actionType: 'create', actionName: 'create',
        changes: auditCreated(reconSnap(item), RECON_AUDIT),
      })
      return item
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建银行对账记录失败', WRITE_MAP)
    }
  }

  async function createReconciliation(actor: Actor, input: {
    bankTransactionId: string; journalId: string; amount: string
  }) {
    requirePerm(actor, 'acc.bank_transaction:reconcile', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const transaction = await loadTransaction(trx, input.bankTransactionId, true)
      requireCompanyAccess(actor, transaction.companyId, '银行流水')
      return createReconciliationLocked(trx, actor, transaction, input.journalId, input.amount)
    })
  }

  async function remaining(actor: Actor, bankTransactionId: string, journalId: string) {
    requirePerm(actor, 'acc.bank_transaction:read', '无权限执行银行业务操作')
    requirePerm(actor, 'acc.gl_journal:read', '无权限执行银行业务操作')
    const transaction = await loadTransaction(db, bankTransactionId, false)
    requireCompanyAccess(actor, transaction.companyId, '银行流水或凭证')
    const journalRows = await sql<{ id: string; company_id: string }>`
      SELECT id,company_id FROM acc_gl_journal WHERE id=${journalId}::uuid
    `.execute(db)
    const journal = journalRows.rows[0]
    if (!journal || journal.company_id !== transaction.companyId) {
      throw notFound('银行流水或凭证')
    }
    const ledgerAccountId = await bankLedgerAccount(db, transaction, false)
    const txnUsed = await reconciledTotal(db, transaction.id)
    const { total: lineTotal, used: journalUsed } = await journalCapacity(
      db, journal.id, ledgerAccountId, transaction.income != null,
    )
    let journalRemaining = lineTotal.sub(journalUsed)
    if (journalRemaining.isNegative()) journalRemaining = decimal(0)
    const txnRemaining = txnAmount(transaction.income, transaction.expense).sub(txnUsed)
    const result = txnRemaining.lt(journalRemaining) ? txnRemaining : journalRemaining
    return { amount: result.toFixed() }
  }

  async function createQuickJournal(
    trx: TrxHandle, actor: Actor, input: {
      companyId: string; bankLedgerAccountId: string; counterAccountId: string
      income: boolean; amount: ReturnType<typeof decimal>; summary: string | null; postingDate: string
    },
  ): Promise<string> {
    requirePerm(actor, 'acc.gl_journal:create', '无权限执行银行业务操作')
    requirePerm(actor, 'acc.gl_journal:audit', '无权限执行银行业务操作')
    const no = await numbering.nextInTx(trx, {
      resource: 'acc.gl_journal',
      values: { company_id: input.companyId, date: input.postingDate },
    })
    const ins = await sql<{ id: string }>`
      INSERT INTO acc_gl_journal(voucher_no,date,posting_date,remarks,status,company_id,created_by_id)
      VALUES (${no},${input.postingDate}::date,${input.postingDate}::date,${input.summary},
        'draft',${input.companyId}::uuid,${actorUserId(actor)}::uuid)
      RETURNING id
    `.execute(trx)
    const journalId = ins.rows[0]!.id
    await writeAudit(trx, actor, {
      resource: 'acc_gl_journal', recordId: journalId, recordLabel: no,
      companyId: input.companyId, actionType: 'create', actionName: 'create',
      changes: auditCreated({
        voucher_no: no, date: input.postingDate, posting_date: input.postingDate,
        remarks: input.summary, company_id: input.companyId,
      }, ['voucher_no', 'date', 'posting_date', 'remarks', 'company_id']),
    })
    const currRows = await sql<{ id: string; currency_id: string | null }>`
      SELECT id,currency_id FROM bas_account
      WHERE id=ANY(${[input.bankLedgerAccountId, input.counterAccountId]}::uuid[])
    `.execute(trx)
    const currencies = new Map(currRows.rows.map((r) => [r.id, r.currency_id]))
    if (currencies.size !== 2) {
      throw validation('快速对账', { counterAccountId: ['科目不存在'] })
    }
    const amount = input.amount
    const entries: GlEntry[] = input.income
      ? [
          { accountId: input.bankLedgerAccountId, currencyId: currencies.get(input.bankLedgerAccountId), debit: amount, credit: 0, remarks: input.summary },
          { accountId: input.counterAccountId, currencyId: currencies.get(input.counterAccountId), debit: 0, credit: amount, remarks: input.summary },
        ]
      : [
          { accountId: input.counterAccountId, currencyId: currencies.get(input.counterAccountId), debit: amount, credit: 0, remarks: input.summary },
          { accountId: input.bankLedgerAccountId, currencyId: currencies.get(input.bankLedgerAccountId), debit: 0, credit: amount, remarks: input.summary },
        ]
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const line = await sql<{ id: string }>`
        INSERT INTO acc_gl_journal_line(idx,debit,credit,remarks,journal_id,company_id,account_id,currency_id)
        VALUES (${i + 1},${String(e.debit ?? 0)},${String(e.credit ?? 0)},${e.remarks ?? null},
          ${journalId}::uuid,${input.companyId}::uuid,${e.accountId}::uuid,${e.currencyId ?? null}::uuid)
        RETURNING id
      `.execute(trx)
      await writeAudit(trx, actor, {
        resource: 'acc_gl_journal_line', recordId: line.rows[0]!.id,
        recordLabel: `${no}#${i + 1}`, companyId: input.companyId,
        actionType: 'create', actionName: 'create',
        changes: auditCreated({
          idx: i + 1, debit: String(e.debit ?? 0), credit: String(e.credit ?? 0),
          journal_id: journalId, company_id: input.companyId, account_id: e.accountId,
          currency_id: e.currencyId, remarks: e.remarks,
        }, ['idx', 'debit', 'credit', 'journal_id', 'company_id', 'account_id', 'currency_id', 'remarks']),
      })
    }
    await gl.post(trx, {
      type: 'acc.gl_journal', id: journalId, no, companyId: input.companyId, postingDate: input.postingDate,
    }, entries)
    const updated = await sql`
      UPDATE acc_gl_journal SET status='audited', submitted_at=timezone('utc',now()),
        submitted_by_id=${actorUserId(actor)}::uuid, updated_at=timezone('utc',now())
      WHERE id=${journalId}::uuid AND status='draft'
    `.execute(trx)
    if (Number(updated.numAffectedRows) !== 1) throw conflict('快速对账凭证已被并发处理')
    await writeAudit(trx, actor, {
      resource: 'acc_gl_journal', recordId: journalId, recordLabel: no,
      companyId: input.companyId, actionType: 'update', actionName: 'audit',
      changes: {
        status: { from: 'draft', to: 'audited' },
        submitted_at: { to: new Date().toISOString() },
        submitted_by_id: { to: actorUserId(actor) },
      },
    })
    return journalId
  }

  async function quickCreate(actor: Actor, input: {
    bankTransactionId: string; counterAccountId: string; amount: string
    summary?: string | null; postingDate: string
  }) {
    requirePerm(actor, 'acc.bank_transaction:reconcile', '无权限执行银行业务操作')
    requirePerm(actor, 'acc.gl_journal:create', '无权限执行银行业务操作')
    requirePerm(actor, 'acc.gl_journal:audit', '无权限执行银行业务操作')
    const fields: Record<string, string[]> = {}
    const amount = decimal(input.amount)
    if (!amount.gt(0)) fields.amount = ['对账金额必须大于零']
    if (!input.postingDate) fields.postingDate = ['必填']
    validateOptionalText(fields, 'summary', input.summary, 255)
    if (Object.keys(fields).length) throw validation('快速对账', fields)
    return withTx(db, async (trx) => {
      const transaction = await loadTransaction(trx, input.bankTransactionId, true)
      requireCompanyAccess(actor, transaction.companyId, '银行流水')
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
      const journalId = await createQuickJournal(trx, actor, {
        companyId: transaction.companyId,
        bankLedgerAccountId: ledgerAccountId,
        counterAccountId: input.counterAccountId,
        income: transaction.income != null,
        amount, summary: input.summary ?? null, postingDate: input.postingDate,
      })
      return createReconciliationLocked(trx, actor, transaction, journalId, amount.toFixed())
    })
  }

  async function deleteReconciliation(actor: Actor, id: string) {
    requirePerm(actor, 'acc.bank_transaction:reconcile', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const seed = await loadRecon(trx, id, false)
      const transaction = await loadTransaction(trx, seed.bankTransactionId, true)
      requireCompanyAccess(actor, transaction.companyId, '银行对账记录')
      const item = await loadRecon(trx, id, true)
      if (item.bankTransactionId !== transaction.id) throw conflict('银行对账记录已被并发修改')
      try {
        await sql`DELETE FROM acc_bank_reconciliation WHERE id=${id}::uuid`.execute(trx)
        await refreshBankTransaction(trx, transaction)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_reconciliation', recordId: id,
          recordLabel: `${item.bankTransactionId}/${item.journalId}`,
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
