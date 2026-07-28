/**
 * 银行账户 + 银行流水。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated, auditDestroyed, auditDiff, writeAudit,
} from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { mapWriteError } from '~/db/dberr.ts'
import {
  asIso, conflict, lower, notFound, requireCompanyAccess, requireCompanyWrite,
  requirePerm, upper, validateOptionalText, validateRequiredText, validation,
} from './common.ts'
import { bankAccountResourceMeta, bankTransactionResourceMeta } from './meta.ts'
import {
  loadTransaction,
  mapTransaction,
  reconcileStatus,
  txnAmount,
  txnLabel,
  txnSnap,
  validateTxnShape,
  type BankTransaction,
} from './banking-shared.ts'

export type { BankTransaction } from './banking-shared.ts'
export {
  loadTransaction,
  mapTransaction,
  reconcileStatus,
  txnAmount,
  txnLabel,
  txnSnap,
  validateTxnShape,
} from './banking-shared.ts'

export interface BankAccount {
  id: string; alias: string; bankName: string; branchName: string | null
  holderName: string; accountNo: string; active: boolean; note: string | null
  insertedAt: string; updatedAt: string; companyId: string; currencyId: string
  accountId: string | null
}

const ACCOUNT_AUDIT = [
  'alias','bank_name','branch_name','holder_name','account_no',
  'active','note','company_id','currency_id','account_id',
] as const
const TXN_AUDIT = [
  'occurred_at','income','expense','balance','counterparty_name',
  'counterparty_account','summary','note','company_id','bank_account_id',
] as const
const WRITE_MAP = [
  { code: '23505', message: '银行业务记录冲突' },
  { code: '23503', message: '银行业务引用不存在' },
] as const

export function mapAccount(row: Record<string, unknown>): BankAccount {
  return {
    id: String(row.id), alias: String(row.alias), bankName: String(row.bank_name),
    branchName: row.branch_name == null ? null : String(row.branch_name),
    holderName: String(row.holder_name), accountNo: String(row.account_no),
    active: Boolean(row.active),
    note: row.note == null ? null : String(row.note),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), currencyId: String(row.currency_id),
    accountId: row.account_id == null ? null : String(row.account_id),
  }
}

export function accountSnap(a: BankAccount): Record<string, unknown> {
  return {
    alias: a.alias, bank_name: a.bankName, branch_name: a.branchName,
    holder_name: a.holderName, account_no: a.accountNo, active: a.active,
    note: a.note, company_id: a.companyId, currency_id: a.currencyId, account_id: a.accountId,
  }
}

export async function loadAccount(db: DbHandle, id: string, lock: boolean): Promise<BankAccount> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,alias,bank_name,branch_name,holder_name,account_no,active,note,
      inserted_at,updated_at,company_id,currency_id,account_id
    FROM acc_bank_account WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('银行账户')
  return mapAccount(rows.rows[0])
}

export async function validateOwnBankAccount(
  db: DbHandle, companyId: string, bankAccountId: string, checkActive: boolean,
): Promise<void> {
  const rows = await sql<{ company_id: string; active: boolean }>`
    SELECT company_id, active FROM acc_bank_account WHERE id=${bankAccountId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  if (!row) throw validation('银行流水', { bankAccountId: ['银行账户不存在'] })
  if (row.company_id !== companyId) {
    throw validation('银行流水', { bankAccountId: ['银行账户必须属于同一公司'] })
  }
  if (checkActive && !row.active) {
    throw validation('银行流水', { bankAccountId: ['停用银行账户不可用于新增'] })
  }
}

export async function validateAccountRefs(
  db: DbHandle, companyId: string, currencyId: string, accountId: string | null,
): Promise<void> {
  const company = await sql<{ e: boolean }>`
    SELECT EXISTS(SELECT 1 FROM bas_company WHERE id=${companyId}::uuid) AS e
  `.execute(db)
  if (!company.rows[0]?.e) throw validation('银行账户', { companyId: ['公司不存在'] })
  const currency = await sql<{ e: boolean }>`
    SELECT EXISTS(SELECT 1 FROM bas_currency WHERE id=${currencyId}::uuid) AS e
  `.execute(db)
  if (!currency.rows[0]?.e) throw validation('银行账户', { currencyId: ['货币不存在'] })
  if (!accountId) return
  const acc = await sql<{ company_id: string; is_group: boolean; active: boolean; currency_id: string | null }>`
    SELECT company_id,is_group,active,currency_id FROM bas_account WHERE id=${accountId}::uuid
  `.execute(db)
  const row = acc.rows[0]
  if (!row) throw validation('银行账户', { accountId: ['绑定科目不存在'] })
  if (row.company_id !== companyId) {
    throw validation('银行账户', { accountId: ['绑定科目必须属于同一公司'] })
  }
  if (row.is_group) throw validation('银行账户', { accountId: ['汇总科目不能绑定银行账户'] })
  if (!row.active) throw validation('银行账户', { accountId: ['停用科目不能绑定银行账户'] })
  if (row.currency_id != null && row.currency_id !== currencyId) {
    throw validation('银行账户', { accountId: ['绑定科目币种与账户货币不一致'] })
  }
}

export function createAccountAndTxnOps(db: Kysely<Database>) {
  async function listAccounts(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'acc.bank_account:read', '无权限执行银行业务操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as BankAccount[] }
    return listFromSource({
      db, resource: bankAccountResourceMeta(),
      source: sql` FROM acc_bank_account`,
      select: sql`SELECT id,alias,bank_name,branch_name,holder_name,account_no,active,note,
        inserted_at,updated_at,company_id,currency_id,account_id`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapAccount,
    })
  }

  async function getAccount(actor: Actor, id: string) {
    requirePerm(actor, 'acc.bank_account:read', '无权限执行银行业务操作')
    const item = await loadAccount(db, id, false)
    requireCompanyAccess(actor, item.companyId, '银行账户')
    return item
  }

  async function createAccount(actor: Actor, input: {
    alias: string; bankName: string; holderName: string; accountNo: string
    branchName?: string | null; note?: string | null; active?: boolean | null
    companyId: string; currencyId: string; accountId?: string | null
  }) {
    requirePerm(actor, 'acc.bank_account:create', '无权限执行银行业务操作')
    requireCompanyWrite(actor, input.companyId)
    const fields: Record<string, string[]> = {}
    const alias = validateRequiredText(fields, 'alias', input.alias, 64)
    const bankName = validateRequiredText(fields, 'bankName', input.bankName, 128)
    const holderName = validateRequiredText(fields, 'holderName', input.holderName, 128)
    const accountNo = validateRequiredText(fields, 'accountNo', input.accountNo, 64)
    const branchName = validateOptionalText(fields, 'branchName', input.branchName, 128)
    const note = validateOptionalText(fields, 'note', input.note, 255)
    if (!input.companyId) fields.companyId = ['必填']
    if (!input.currencyId) fields.currencyId = ['必填']
    if (Object.keys(fields).length) throw validation('银行账户', fields)
    const active = input.active ?? true
    return withTx(db, async (trx) => {
      await validateAccountRefs(trx, input.companyId, input.currencyId, input.accountId ?? null)
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO acc_bank_account(alias,bank_name,branch_name,holder_name,account_no,active,note,company_id,currency_id,account_id)
          VALUES (${alias},${bankName},${branchName},${holderName},${accountNo},${active},${note},
            ${input.companyId}::uuid,${input.currencyId}::uuid,${input.accountId ?? null}::uuid)
          RETURNING id
        `.execute(trx)
        const item = await loadAccount(trx, ins.rows[0]!.id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_account', recordId: item.id, recordLabel: item.alias,
          companyId: item.companyId, actionType: 'create', actionName: 'create',
          changes: auditCreated(accountSnap(item), ACCOUNT_AUDIT),
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建银行账户失败', WRITE_MAP)
      }
    })
  }

  async function updateAccount(actor: Actor, id: string, input: {
    alias?: string; bankName?: string; holderName?: string; accountNo?: string
    branchName?: string | null; branchNamePresent?: boolean
    note?: string | null; notePresent?: boolean
    active?: boolean; currencyId?: string
    accountId?: string | null; accountIdPresent?: boolean
  }) {
    requirePerm(actor, 'acc.bank_account:update', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const before = await loadAccount(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '银行账户')
      const after = { ...before }
      if (input.alias !== undefined) after.alias = input.alias
      if (input.bankName !== undefined) after.bankName = input.bankName
      if (input.branchNamePresent) after.branchName = input.branchName ?? null
      if (input.holderName !== undefined) after.holderName = input.holderName
      if (input.accountNo !== undefined) after.accountNo = input.accountNo
      if (input.active !== undefined) after.active = input.active
      if (input.notePresent) after.note = input.note ?? null
      if (input.currencyId !== undefined) after.currencyId = input.currencyId
      const accountChanged = input.accountIdPresent && (before.accountId ?? null) !== (input.accountId ?? null)
      if (input.accountIdPresent) after.accountId = input.accountId ?? null
      const fields: Record<string, string[]> = {}
      after.alias = validateRequiredText(fields, 'alias', after.alias, 64)
      after.bankName = validateRequiredText(fields, 'bankName', after.bankName, 128)
      after.holderName = validateRequiredText(fields, 'holderName', after.holderName, 128)
      after.accountNo = validateRequiredText(fields, 'accountNo', after.accountNo, 64)
      after.branchName = validateOptionalText(fields, 'branchName', after.branchName, 128)
      after.note = validateOptionalText(fields, 'note', after.note, 255)
      if (Object.keys(fields).length) throw validation('银行账户', fields)
      await validateAccountRefs(trx, after.companyId, after.currencyId, after.accountId)
      if (accountChanged) {
        const used = await sql<{ e: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM acc_bank_reconciliation r
            JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
            WHERE t.bank_account_id=${id}::uuid) AS e
        `.execute(trx)
        if (used.rows[0]?.e) throw conflict('账户名下流水存在对账记录,不允许更换绑定科目,请先解除对账')
      }
      const changes = auditDiff(accountSnap(before), accountSnap(after), ACCOUNT_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE acc_bank_account SET
            alias=${after.alias},bank_name=${after.bankName},branch_name=${after.branchName},
            holder_name=${after.holderName},account_no=${after.accountNo},active=${after.active},
            note=${after.note},currency_id=${after.currencyId}::uuid,account_id=${after.accountId}::uuid,
            updated_at=timezone('utc',now()) WHERE id=${id}::uuid
        `.execute(trx)
        const item = await loadAccount(trx, id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_account', recordId: id, recordLabel: item.alias,
          companyId: item.companyId, actionType: 'update', actionName: 'update', changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新银行账户失败', WRITE_MAP)
      }
    })
  }

  async function deleteAccount(actor: Actor, id: string) {
    requirePerm(actor, 'acc.bank_account:delete', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const item = await loadAccount(trx, id, true)
      requireCompanyAccess(actor, item.companyId, '银行账户')
      try {
        await sql`DELETE FROM acc_bank_account WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_account', recordId: id, recordLabel: item.alias,
          companyId: item.companyId, actionType: 'destroy', actionName: 'destroy',
          changes: auditDestroyed(accountSnap(item), ACCOUNT_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除银行账户失败', WRITE_MAP)
      }
    })
  }

  async function listTransactions(actor: Actor, query: Partial<ListQuery>) {
    requirePerm(actor, 'acc.bank_transaction:read', '无权限执行银行业务操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as BankTransaction[] }
    return listFromSource({
      db, resource: bankTransactionResourceMeta(),
      source: sql` FROM acc_bank_transaction`,
      select: sql`SELECT id,occurred_at,income,expense,balance,counterparty_name,counterparty_account,
        summary,note,reconciled_amount,unreconciled_amount,reconcile_status,inserted_at,updated_at,company_id,bank_account_id`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapTransaction,
    })
  }

  async function getTransaction(actor: Actor, id: string) {
    requirePerm(actor, 'acc.bank_transaction:read', '无权限执行银行业务操作')
    const item = await loadTransaction(db, id, false)
    requireCompanyAccess(actor, item.companyId, '银行流水')
    return item
  }

  async function createTransactionInTx(
    trx: DbHandle, actor: Actor,
    input: {
      occurredAt: string; income?: string | null; expense?: string | null; balance?: string | null
      counterpartyName?: string | null; counterpartyAccount?: string | null
      summary?: string | null; note?: string | null; companyId: string; bankAccountId: string
    },
    requireActive: boolean,
  ) {
    validateTxnShape(
      input.occurredAt, input.income ?? null, input.expense ?? null,
      input.counterpartyName ?? null, input.counterpartyAccount ?? null,
      input.summary ?? null, input.note ?? null,
    )
    await validateOwnBankAccount(trx, input.companyId, input.bankAccountId, requireActive)
    const amount = txnAmount(input.income ?? null, input.expense ?? null)
    try {
      const ins = await sql<{ id: string }>`
        INSERT INTO acc_bank_transaction(
          occurred_at,income,expense,balance,counterparty_name,counterparty_account,
          summary,note,reconciled_amount,unreconciled_amount,reconcile_status,company_id,bank_account_id)
        VALUES (
          ${input.occurredAt}::timestamptz,${input.income ?? null},${input.expense ?? null},
          ${input.balance ?? null},${input.counterpartyName ?? null},${input.counterpartyAccount ?? null},
          ${input.summary ?? null},${input.note ?? null},0,${amount.toFixed()},'unreconciled',
          ${input.companyId}::uuid,${input.bankAccountId}::uuid)
        RETURNING id
      `.execute(trx)
      const item = await loadTransaction(trx, ins.rows[0]!.id, false)
      await writeAudit(trx, actor, {
        resource: 'acc_bank_transaction', recordId: item.id, recordLabel: txnLabel(item),
        companyId: item.companyId, actionType: 'create', actionName: 'create',
        changes: auditCreated(txnSnap(item), TXN_AUDIT),
      })
      return item
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建银行流水失败', WRITE_MAP)
    }
  }

  async function createTransaction(actor: Actor, input: Parameters<typeof createTransactionInTx>[2]) {
    requirePerm(actor, 'acc.bank_transaction:create', '无权限执行银行业务操作')
    requireCompanyWrite(actor, input.companyId)
    return withTx(db, (trx) => createTransactionInTx(trx, actor, input, true))
  }

  async function updateTransaction(actor: Actor, id: string, input: {
    occurredAt?: string
    income?: string | null; incomePresent?: boolean
    expense?: string | null; expensePresent?: boolean
    balance?: string | null; balancePresent?: boolean
    counterpartyName?: string | null; counterpartyNamePresent?: boolean
    counterpartyAccount?: string | null; counterpartyAccountPresent?: boolean
    summary?: string | null; summaryPresent?: boolean
    note?: string | null; notePresent?: boolean
    bankAccountId?: string
  }) {
    requirePerm(actor, 'acc.bank_transaction:update', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const before = await loadTransaction(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '银行流水')
      const after = { ...before }
      if (input.occurredAt !== undefined) after.occurredAt = new Date(input.occurredAt).toISOString()
      if (input.incomePresent) after.income = input.income ?? null
      if (input.expensePresent) after.expense = input.expense ?? null
      if (input.balancePresent) after.balance = input.balance ?? null
      if (input.counterpartyNamePresent) after.counterpartyName = input.counterpartyName ?? null
      if (input.counterpartyAccountPresent) after.counterpartyAccount = input.counterpartyAccount ?? null
      if (input.summaryPresent) after.summary = input.summary ?? null
      if (input.notePresent) after.note = input.note ?? null
      if (input.bankAccountId !== undefined) after.bankAccountId = input.bankAccountId
      validateTxnShape(after.occurredAt, after.income, after.expense, after.counterpartyName, after.counterpartyAccount, after.summary, after.note)
      await validateOwnBankAccount(trx, after.companyId, after.bankAccountId, false)
      const totalRow = await sql<{ s: string }>`
        SELECT COALESCE(sum(amount),0)::text AS s FROM acc_bank_reconciliation WHERE bank_transaction_id=${id}::uuid
      `.execute(trx)
      const total = decimal(totalRow.rows[0]?.s ?? '0')
      const hasLinks = total.gt(0)
      if (hasLinks && before.bankAccountId !== after.bankAccountId) throw conflict('流水已有对账记录,不允许更换银行账户')
      if (hasLinks && (before.income != null) !== (after.income != null)) throw conflict('流水已有对账记录,不允许收支换边')
      const amount = txnAmount(after.income, after.expense)
      if (amount.lt(total)) throw validation('银行流水', { amount: [`金额不得低于已对账金额(已对账 ${total.toFixed()})`] })
      after.reconciledAmount = total.toFixed()
      after.unreconciledAmount = amount.sub(total).toFixed()
      after.reconcileStatus = reconcileStatus(total, amount)
      const changes = auditDiff(txnSnap(before), txnSnap(after), TXN_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE acc_bank_transaction SET
            occurred_at=${after.occurredAt}::timestamptz,income=${after.income},expense=${after.expense},
            balance=${after.balance},counterparty_name=${after.counterpartyName},
            counterparty_account=${after.counterpartyAccount},summary=${after.summary},note=${after.note},
            bank_account_id=${after.bankAccountId}::uuid,reconciled_amount=${total.toFixed()},
            unreconciled_amount=${after.unreconciledAmount},reconcile_status=${lower(after.reconcileStatus)},
            updated_at=timezone('utc',now()) WHERE id=${id}::uuid
        `.execute(trx)
        const item = await loadTransaction(trx, id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_transaction', recordId: id, recordLabel: txnLabel(item),
          companyId: item.companyId, actionType: 'update', actionName: 'update', changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新银行流水失败', WRITE_MAP)
      }
    })
  }

  async function deleteTransaction(actor: Actor, id: string) {
    requirePerm(actor, 'acc.bank_transaction:delete', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const item = await loadTransaction(trx, id, true)
      requireCompanyAccess(actor, item.companyId, '银行流水')
      const linked = await sql<{ e: boolean }>`
        SELECT EXISTS(SELECT 1 FROM acc_bank_reconciliation WHERE bank_transaction_id=${id}::uuid) AS e
      `.execute(trx)
      if (linked.rows[0]?.e) throw conflict('流水已有对账记录,请先解除对账后再删除')
      try {
        await sql`DELETE FROM acc_bank_transaction WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_transaction', recordId: id, recordLabel: txnLabel(item),
          companyId: item.companyId, actionType: 'destroy', actionName: 'destroy',
          changes: auditDestroyed(txnSnap(item), TXN_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除银行流水失败', WRITE_MAP)
      }
    })
  }

  return {
    listAccounts, getAccount, createAccount, updateAccount, deleteAccount,
    listTransactions, getTransaction, createTransaction, updateTransaction, deleteTransaction,
    createTransactionInTx,
  }
}
