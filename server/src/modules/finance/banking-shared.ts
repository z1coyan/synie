/**
 * 银行域共享：流水形状/装载/金额与对账状态。
 * 依赖方向单向（ops → shared），避免 accounts ↔ import 动态 import 环。
 */
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import {
  asIso, notFound, validateOptionalText, validation, wireDec, wireDecRequired, wireEnum,
} from './common.ts'

export interface BankTransaction {
  id: string; occurredAt: string; income: string | null; expense: string | null
  balance: string | null; counterpartyName: string | null
  counterpartyAccount: string | null; summary: string | null; note: string | null
  reconciledAmount: string; unreconciledAmount: string; reconcileStatus: string
  insertedAt: string; updatedAt: string; companyId: string; bankAccountId: string
}

export function mapTransaction(row: Record<string, unknown>): BankTransaction {
  return {
    id: String(row.id), occurredAt: asIso(row.occurred_at),
    income: wireDec(row.income), expense: wireDec(row.expense), balance: wireDec(row.balance),
    counterpartyName: row.counterparty_name == null ? null : String(row.counterparty_name),
    counterpartyAccount: row.counterparty_account == null ? null : String(row.counterparty_account),
    summary: row.summary == null ? null : String(row.summary),
    note: row.note == null ? null : String(row.note),
    reconciledAmount: wireDecRequired(row.reconciled_amount),
    unreconciledAmount: wireDecRequired(row.unreconciled_amount),
    reconcileStatus: wireEnum(row.reconcile_status),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), bankAccountId: String(row.bank_account_id),
  }
}

export function txnSnap(t: BankTransaction): Record<string, unknown> {
  return {
    occurred_at: t.occurredAt, income: t.income, expense: t.expense, balance: t.balance,
    counterparty_name: t.counterpartyName, counterparty_account: t.counterpartyAccount,
    summary: t.summary, note: t.note, company_id: t.companyId, bank_account_id: t.bankAccountId,
  }
}

export function txnLabel(t: BankTransaction): string {
  return t.summary && t.summary !== '' ? t.summary : t.id
}

export function txnAmount(income: string | null, expense: string | null) {
  if (income != null) return decimal(income)
  if (expense != null) return decimal(expense)
  return decimal(0)
}

export function reconcileStatus(
  reconciled: ReturnType<typeof decimal>,
  amount: ReturnType<typeof decimal>,
): string {
  if (reconciled.isZero()) return 'UNRECONCILED'
  if (reconciled.lt(amount)) return 'PARTIAL'
  return 'RECONCILED'
}

export async function loadTransaction(
  db: DbHandle,
  id: string,
  lock: boolean,
): Promise<BankTransaction> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,occurred_at,income,expense,balance,counterparty_name,counterparty_account,
      summary,note,reconciled_amount,unreconciled_amount,reconcile_status,
      inserted_at,updated_at,company_id,bank_account_id
    FROM acc_bank_transaction WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('银行流水')
  return mapTransaction(rows.rows[0])
}

export function validateTxnShape(
  occurredAt: string,
  income: string | null, expense: string | null,
  counterpartyName: string | null, counterpartyAccount: string | null,
  summary: string | null, note: string | null,
): void {
  const fields: Record<string, string[]> = {}
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) fields.occurredAt = ['必填']
  if (income == null && expense == null) fields.income = ['收入或支出必须填写一项']
  else if (income != null && expense != null) fields.expense = ['收入与支出只能填写一项']
  else if (!txnAmount(income, expense).gt(0)) fields.amount = ['金额必须大于零']
  validateOptionalText(fields, 'counterpartyName', counterpartyName, 128)
  validateOptionalText(fields, 'counterpartyAccount', counterpartyAccount, 64)
  validateOptionalText(fields, 'summary', summary, 255)
  validateOptionalText(fields, 'note', note, 255)
  if (Object.keys(fields).length) throw validation('银行流水', fields)
}
