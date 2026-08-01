import { Decimal, roundAmount, scaledInt64ToDecimal } from '@synie/shared'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'
import type { DataModel, Id } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { authedMutation, authedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { decimalToScaledInt64 } from '../../lib/decimal'
import { synieError, validationError } from '../../lib/errors'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { requirePermission } from '../../lib/permissions'
import { postGlInMutation } from '../../engines/gl/engine'
import {
  childrenFor,
  createDomainRecord,
  hydrateStored,
  patchDomainComputed,
  patchDomainStatus,
  removeDomainRecord,
  updateDomainRecord,
} from '../shared/records'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type Ctx = QueryCtx | MutationCtx
type Wire = Record<string, unknown>

const TRANSACTION = 'accBankTransactions'
const RECONCILIATION = 'accBankReconciliations'

function object(value: unknown): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', '参数必须是对象')
  }
  return value as Wire
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || [...text].length > max) {
    throw validationError('银行业务参数不合法', { [field]: [`必填且不能超过 ${max} 字符`] })
  }
  return text
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || [...value.trim()].length > max) {
    throw validationError('银行业务参数不合法', { [field]: [`不能超过 ${max} 字符`] })
  }
  return value.trim() || null
}

function amount(value: unknown, field: string, options: { positive?: boolean } = {}): Decimal {
  if (typeof value !== 'string') {
    throw validationError('银行业务参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  let result: Decimal
  try { result = new Decimal(value) } catch {
    throw validationError('银行业务参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  if (!result.isFinite() || (options.positive && !result.gt(0))) {
    throw validationError('银行业务参数不合法', { [field]: ['必须大于零'] })
  }
  return result
}

function datetime(value: unknown): string {
  const instant = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  if (!Number.isFinite(instant)) {
    throw validationError('银行流水参数不合法', { occurredAt: ['必须是有效时间'] })
  }
  return new Date(instant).toISOString()
}

function dateOnly(value: unknown): string {
  const text = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw validationError('快速对账参数不合法', { postingDate: ['必须是有效 YYYY-MM-DD 日期'] })
  }
  return text
}

function requireCompany(actor: Actor, companyId: unknown): string {
  if (typeof companyId !== 'string' || !companyId || !canAccessCompany(actor, companyId)) {
    throw synieError('not_found', '公司或银行业务记录不存在')
  }
  return companyId
}

async function loadClosure(ctx: Ctx, table: 'financeDocuments' | 'accountingDocuments', resource: string, id: string): Promise<Wire> {
  const normalized = ctx.db.normalizeId(table, id)
  const row = normalized ? await ctx.db.get(normalized) : null
  if (!row || row.resource !== resource) throw synieError('not_found', '银行业务记录不存在')
  return hydrateStored(row)
}

async function validateAccountReferences(
  ctx: Ctx,
  companyId: string,
  currencyId: string,
  accountId: string | null,
): Promise<void> {
  const companyKey = ctx.db.normalizeId('companies', companyId)
  const currencyKey = ctx.db.normalizeId('currencies', currencyId)
  const [company, currency] = await Promise.all([
    companyKey ? ctx.db.get(companyKey) : null,
    currencyKey ? ctx.db.get(currencyKey) : null,
  ])
  if (!company) throw validationError('银行账户参数不合法', { companyId: ['公司不存在'] })
  if (!currency) throw validationError('银行账户参数不合法', { currencyId: ['货币不存在'] })
  if (!accountId) return
  const accountKey = ctx.db.normalizeId('accounts', accountId)
  const account = accountKey ? await ctx.db.get(accountKey) : null
  if (!account) throw validationError('银行账户参数不合法', { accountId: ['绑定科目不存在'] })
  if (String(account.companyId) !== companyId) {
    throw validationError('银行账户参数不合法', { accountId: ['绑定科目必须属于同一公司'] })
  }
  if (account.isGroup) throw validationError('银行账户参数不合法', { accountId: ['汇总科目不能绑定银行账户'] })
  if (!account.active) throw validationError('银行账户参数不合法', { accountId: ['停用科目不能绑定银行账户'] })
  if (account.currencyId !== null && String(account.currencyId) !== currencyId) {
    throw validationError('银行账户参数不合法', { accountId: ['绑定科目币种与账户货币不一致'] })
  }
}

function normalizeAccount(input: Wire, previous?: Wire): Wire {
  const companyId = String(previous?.companyId ?? input.companyId ?? '')
  const currencyId = String(input.currencyId ?? previous?.currencyId ?? '')
  if (!currencyId) throw validationError('银行账户参数不合法', { currencyId: ['必填'] })
  const accountIdValue = input.accountId === undefined ? previous?.accountId : input.accountId
  return {
    alias: requiredText(input.alias ?? previous?.alias, 'alias', 64),
    bankName: requiredText(input.bankName ?? previous?.bankName, 'bankName', 128),
    branchName: optionalText(input.branchName === undefined ? previous?.branchName : input.branchName, 'branchName', 128),
    holderName: requiredText(input.holderName ?? previous?.holderName, 'holderName', 128),
    accountNo: requiredText(input.accountNo ?? previous?.accountNo, 'accountNo', 64),
    active: input.active === undefined ? (previous?.active ?? true) : input.active,
    note: optionalText(input.note === undefined ? previous?.note : input.note, 'note', 255),
    companyId,
    currencyId,
    accountId: typeof accountIdValue === 'string' && accountIdValue ? accountIdValue : null,
  }
}

async function replaceTransactionIndex(ctx: MutationCtx, recordId: string, wire: Wire | null): Promise<void> {
  const existing = await ctx.db.query('financeBankingIndex').withIndex('by_record', (q) =>
    q.eq('resource', TRANSACTION).eq('recordId', recordId),
  ).collect()
  for (const row of existing) await ctx.db.delete(row._id)
  if (!wire) return
  await ctx.db.insert('financeBankingIndex', {
    resource: TRANSACTION,
    recordId,
    companyId: String(wire.companyId),
    bankAccountId: String(wire.bankAccountId),
    bankTransactionId: null,
    journalId: null,
    ledgerAccountId: null,
    income: null,
    amountScaled: 0n,
  })
}

async function replaceReconciliationIndex(
  ctx: MutationCtx,
  recordId: string,
  facts: null | {
    companyId: string
    bankAccountId: string
    bankTransactionId: string
    journalId: string
    ledgerAccountId: string
    income: boolean
    amount: string
  },
): Promise<void> {
  const existing = await ctx.db.query('financeBankingIndex').withIndex('by_record', (q) =>
    q.eq('resource', RECONCILIATION).eq('recordId', recordId),
  ).collect()
  for (const row of existing) await ctx.db.delete(row._id)
  if (!facts) return
  await ctx.db.insert('financeBankingIndex', {
    resource: RECONCILIATION,
    recordId,
    companyId: facts.companyId,
    bankAccountId: facts.bankAccountId,
    bankTransactionId: facts.bankTransactionId,
    journalId: facts.journalId,
    ledgerAccountId: facts.ledgerAccountId,
    income: facts.income,
    amountScaled: decimalToScaledInt64(facts.amount, 2),
  })
}

async function reconciliationRowsForTransaction(ctx: Ctx, transactionId: string) {
  return ctx.db.query('financeBankingIndex').withIndex('by_resource_transaction', (q) =>
    q.eq('resource', RECONCILIATION).eq('bankTransactionId', transactionId),
  ).collect()
}

async function reconciledTotal(ctx: Ctx, transactionId: string): Promise<Decimal> {
  const rows = await reconciliationRowsForTransaction(ctx, transactionId)
  return rows.reduce((sum, row) => sum.add(scaledInt64ToDecimal(row.amountScaled, 2)), new Decimal(0))
}

function transactionAmount(wire: Wire): Decimal {
  return new Decimal(String(wire.income ?? wire.expense ?? '0'))
}

function transactionStatus(reconciled: Decimal, total: Decimal): 'UNRECONCILED' | 'PARTIAL' | 'RECONCILED' {
  if (reconciled.isZero()) return 'UNRECONCILED'
  return reconciled.lt(total) ? 'PARTIAL' : 'RECONCILED'
}

async function validateOwnBankAccount(
  ctx: Ctx,
  companyId: string,
  bankAccountId: string,
  active: boolean,
): Promise<Wire> {
  const account = await loadClosure(ctx, 'financeDocuments', 'accBankAccounts', bankAccountId)
  if (account.companyId !== companyId) {
    throw validationError('银行流水参数不合法', { bankAccountId: ['银行账户必须属于同一公司'] })
  }
  if (active && account.active !== true) {
    throw validationError('银行流水参数不合法', { bankAccountId: ['停用银行账户不可用于新增'] })
  }
  return account
}

function normalizeTransaction(input: Wire, previous?: Wire): Wire {
  const incomeValue = input.income === undefined ? previous?.income : input.income
  const expenseValue = input.expense === undefined ? previous?.expense : input.expense
  if ((incomeValue == null) === (expenseValue == null)) {
    throw validationError('银行流水参数不合法', { income: ['收入或支出必须且只能填写一项'] })
  }
  const selected = amount(String(incomeValue ?? expenseValue), 'amount', { positive: true })
  const balanceValue = input.balance === undefined ? previous?.balance : input.balance
  const balance = balanceValue == null || balanceValue === '' ? null : amount(String(balanceValue), 'balance').toString()
  const companyId = String(previous?.companyId ?? input.companyId ?? '')
  const bankAccountId = String(input.bankAccountId ?? previous?.bankAccountId ?? '')
  if (!companyId) throw validationError('银行流水参数不合法', { companyId: ['必填'] })
  if (!bankAccountId) throw validationError('银行流水参数不合法', { bankAccountId: ['必填'] })
  return {
    occurredAt: datetime(input.occurredAt ?? previous?.occurredAt),
    income: incomeValue == null ? null : roundAmount(selected),
    expense: expenseValue == null ? null : roundAmount(selected),
    balance,
    counterpartyName: optionalText(input.counterpartyName === undefined ? previous?.counterpartyName : input.counterpartyName, 'counterpartyName', 128),
    counterpartyAccount: optionalText(input.counterpartyAccount === undefined ? previous?.counterpartyAccount : input.counterpartyAccount, 'counterpartyAccount', 64),
    summary: optionalText(input.summary === undefined ? previous?.summary : input.summary, 'summary', 255),
    note: optionalText(input.note === undefined ? previous?.note : input.note, 'note', 255),
    companyId,
    bankAccountId,
  }
}

export async function createBankAccountRecord(ctx: MutationCtx, actor: Actor, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'acc.bank_account:create')
  const normalized = normalizeAccount(object(raw))
  requireCompany(actor, normalized.companyId)
  await validateAccountReferences(ctx, String(normalized.companyId), String(normalized.currencyId), normalized.accountId as string | null)
  return createDomainRecord(ctx, actor, 'accBankAccounts', {}, { permissionChecked: true, trustedDerived: normalized })
}

export async function updateBankAccountRecord(ctx: MutationCtx, actor: Actor, id: string, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'acc.bank_account:update')
  const before = await loadClosure(ctx, 'financeDocuments', 'accBankAccounts', id)
  requireCompany(actor, before.companyId)
  const normalized = normalizeAccount(object(raw), before)
  await validateAccountReferences(ctx, String(before.companyId), String(normalized.currencyId), normalized.accountId as string | null)
  if (normalized.accountId !== before.accountId) {
    const linked = await ctx.db.query('financeBankingIndex').withIndex('by_resource_bank_account', (q) =>
      q.eq('resource', RECONCILIATION).eq('bankAccountId', id),
    ).first()
    if (linked) throw synieError('conflict', '账户名下流水存在对账记录,不允许更换绑定科目,请先解除对账')
  }
  return updateDomainRecord(ctx, actor, 'accBankAccounts', id, {}, { permissionChecked: true, trustedDerived: normalized })
}

export async function removeBankAccountRecord(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, 'acc.bank_account:delete')
  const before = await loadClosure(ctx, 'financeDocuments', 'accBankAccounts', id)
  requireCompany(actor, before.companyId)
  await removeDomainRecord(ctx, actor, 'accBankAccounts', id, { permissionChecked: true })
}

export async function createBankTransactionRecord(ctx: MutationCtx, actor: Actor, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'acc.bank_transaction:create')
  const normalized = normalizeTransaction(object(raw))
  requireCompany(actor, normalized.companyId)
  await validateOwnBankAccount(ctx, String(normalized.companyId), String(normalized.bankAccountId), true)
  const total = transactionAmount(normalized)
  const result = await createDomainRecord(ctx, actor, TRANSACTION, {}, {
    permissionChecked: true,
    trustedDerived: {
      ...normalized,
      reconciledAmount: '0',
      unreconciledAmount: roundAmount(total),
      reconcileStatus: 'UNRECONCILED',
    },
  })
  await replaceTransactionIndex(ctx, String(result.id), result)
  return result
}

export async function updateBankTransactionRecord(ctx: MutationCtx, actor: Actor, id: string, raw: unknown): Promise<Wire> {
  requirePermission(actor, 'acc.bank_transaction:update')
  const before = await loadClosure(ctx, 'financeDocuments', TRANSACTION, id)
  requireCompany(actor, before.companyId)
  const normalized = normalizeTransaction(object(raw), before)
  await validateOwnBankAccount(ctx, String(before.companyId), String(normalized.bankAccountId), false)
  const used = await reconciledTotal(ctx, id)
  const hasLinks = used.gt(0)
  if (hasLinks && normalized.bankAccountId !== before.bankAccountId) {
    throw synieError('conflict', '流水已有对账记录,不允许更换银行账户')
  }
  if (hasLinks && (normalized.income !== null) !== (before.income !== null)) {
    throw synieError('conflict', '流水已有对账记录,不允许收支换边')
  }
  const total = transactionAmount(normalized)
  if (total.lt(used)) {
    throw validationError('银行流水参数不合法', { amount: [`金额不得低于已对账金额(已对账 ${used.toString()})`] })
  }
  const result = await updateDomainRecord(ctx, actor, TRANSACTION, id, {}, {
    permissionChecked: true,
    trustedDerived: {
      ...normalized,
      reconciledAmount: roundAmount(used),
      unreconciledAmount: roundAmount(total.sub(used)),
      reconcileStatus: transactionStatus(used, total),
    },
  })
  await replaceTransactionIndex(ctx, id, result)
  return result
}

export async function removeBankTransactionRecord(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, 'acc.bank_transaction:delete')
  const before = await loadClosure(ctx, 'financeDocuments', TRANSACTION, id)
  requireCompany(actor, before.companyId)
  if ((await reconciliationRowsForTransaction(ctx, id)).length) {
    throw synieError('conflict', '流水已有对账记录,请先解除对账后再删除')
  }
  await removeDomainRecord(ctx, actor, TRANSACTION, id, { permissionChecked: true })
  await replaceTransactionIndex(ctx, id, null)
}

async function bankLedgerAccount(ctx: Ctx, transaction: Wire): Promise<{ bankAccountId: string; ledgerAccountId: string }> {
  const bankAccountId = String(transaction.bankAccountId)
  const account = await loadClosure(ctx, 'financeDocuments', 'accBankAccounts', bankAccountId)
  if (typeof account.accountId !== 'string' || !account.accountId) {
    throw validationError('银行对账参数不合法', { bankTransactionId: ['银行账户未绑定会计科目'] })
  }
  return { bankAccountId, ledgerAccountId: account.accountId }
}

async function journalCapacity(
  ctx: Ctx,
  journalId: string,
  ledgerAccountId: string,
  income: boolean,
): Promise<{ total: Decimal; used: Decimal }> {
  const lines = await childrenFor(ctx, 'accGlJournalLines', journalId)
  const total = lines
    .filter((line) => line.accountId === ledgerAccountId)
    .reduce((sum, line) => sum.add(String(income ? line.debit ?? '0' : line.credit ?? '0')), new Decimal(0))
  const indexes = await ctx.db.query('financeBankingIndex').withIndex('by_resource_journal', (q) =>
    q.eq('resource', RECONCILIATION).eq('journalId', journalId),
  ).collect()
  const used = indexes
    .filter((row) => row.ledgerAccountId === ledgerAccountId && row.income === income)
    .reduce((sum, row) => sum.add(scaledInt64ToDecimal(row.amountScaled, 2)), new Decimal(0))
  return { total, used }
}

async function refreshTransaction(ctx: MutationCtx, actor: Actor, transaction: Wire, action: string): Promise<Wire> {
  const used = await reconciledTotal(ctx, String(transaction.id))
  const total = transactionAmount(transaction)
  return patchDomainComputed(ctx, actor, TRANSACTION, String(transaction.id), {
    reconciledAmount: roundAmount(used),
    unreconciledAmount: roundAmount(total.sub(used)),
    reconcileStatus: transactionStatus(used, total),
  }, action)
}

export async function createBankReconciliation(
  ctx: MutationCtx,
  actor: Actor,
  transactionId: string,
  journalId: string,
  amountWire: string,
): Promise<Wire> {
  requirePermission(actor, 'acc.bank_transaction:reconcile')
  const transaction = await loadClosure(ctx, 'financeDocuments', TRANSACTION, transactionId)
  requireCompany(actor, transaction.companyId)
  const reconciliationAmount = new Decimal(roundAmount(amount(amountWire, 'amount', { positive: true })))
  const journal = await loadClosure(ctx, 'accountingDocuments', 'accGlJournals', journalId)
  if (journal.companyId !== transaction.companyId) {
    throw validationError('银行对账参数不合法', { journalId: ['凭证与流水必须属于同一公司'] })
  }
  if (journal.status !== 'AUDITED') {
    throw validationError('银行对账参数不合法', { journalId: ['仅已审核凭证可用于对账'] })
  }
  const { bankAccountId, ledgerAccountId } = await bankLedgerAccount(ctx, transaction)
  const income = transaction.income !== null && transaction.income !== undefined
  const transactionUsed = await reconciledTotal(ctx, transactionId)
  const { total: lineTotal, used: journalUsed } = await journalCapacity(ctx, journalId, ledgerAccountId, income)
  const side = income ? '借方' : '贷方'
  if (!lineTotal.gt(0)) {
    throw validationError('银行对账参数不合法', { journalId: [`凭证不含该银行科目的${side}分录行,方向不匹配`] })
  }
  const transactionRemaining = transactionAmount(transaction).sub(transactionUsed)
  if (reconciliationAmount.gt(transactionRemaining)) {
    throw validationError('银行对账参数不合法', { amount: [`超过流水未对账金额(剩余 ${transactionRemaining.toString()})`] })
  }
  const journalRemaining = lineTotal.sub(journalUsed)
  if (reconciliationAmount.gt(journalRemaining)) {
    throw validationError('银行对账参数不合法', { amount: [`超过凭证可对账余额(该科目${side}剩余 ${journalRemaining.toString()})`] })
  }
  const rounded = roundAmount(reconciliationAmount)
  const result = await createDomainRecord(ctx, actor, RECONCILIATION, {}, {
    permissionChecked: true,
    trustedDerived: {
      amount: rounded,
      companyId: transaction.companyId,
      bankTransactionId: transactionId,
      journalId,
    },
  })
  await replaceReconciliationIndex(ctx, String(result.id), {
    companyId: String(transaction.companyId), bankAccountId, bankTransactionId: transactionId,
    journalId, ledgerAccountId, income, amount: rounded,
  })
  await refreshTransaction(ctx, actor, transaction, 'reconcile')
  return result
}

export async function removeBankReconciliation(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, 'acc.bank_transaction:reconcile')
  const reconciliation = await loadClosure(ctx, 'financeDocuments', RECONCILIATION, id)
  const transaction = await loadClosure(ctx, 'financeDocuments', TRANSACTION, String(reconciliation.bankTransactionId))
  requireCompany(actor, transaction.companyId)
  await removeDomainRecord(ctx, actor, RECONCILIATION, id, { permissionChecked: true })
  await replaceReconciliationIndex(ctx, id, null)
  await refreshTransaction(ctx, actor, transaction, 'unreconcile')
}

export async function assertJournalNotBankReconciled(ctx: Ctx, journalId: string): Promise<void> {
  const linked = await ctx.db.query('financeBankingIndex').withIndex('by_resource_journal', (q) =>
    q.eq('resource', RECONCILIATION).eq('journalId', journalId),
  ).first()
  if (linked) throw synieError('conflict', '会计凭证已被银行对账引用,请先解除对账')
}

async function remainingAmount(ctx: Ctx, actor: Actor, transactionId: string, journalId: string): Promise<string> {
  requirePermission(actor, 'acc.bank_transaction:read')
  requirePermission(actor, 'acc.gl_journal:read')
  const transaction = await loadClosure(ctx, 'financeDocuments', TRANSACTION, transactionId)
  requireCompany(actor, transaction.companyId)
  const journal = await loadClosure(ctx, 'accountingDocuments', 'accGlJournals', journalId)
  if (journal.companyId !== transaction.companyId) throw synieError('not_found', '银行流水或凭证不存在')
  const { ledgerAccountId } = await bankLedgerAccount(ctx, transaction)
  const used = await reconciledTotal(ctx, transactionId)
  const capacity = await journalCapacity(ctx, journalId, ledgerAccountId, transaction.income != null)
  const transactionRemaining = Decimal.max(0, transactionAmount(transaction).sub(used))
  const journalRemaining = Decimal.max(0, capacity.total.sub(capacity.used))
  return roundAmount(Decimal.min(transactionRemaining, journalRemaining))
}

async function createQuickJournal(
  ctx: MutationCtx,
  actor: Actor,
  input: {
    companyId: string
    ledgerAccountId: string
    counterAccountId: string
    income: boolean
    amount: Decimal
    summary: string | null
    postingDate: string
  },
): Promise<Wire> {
  const rounded = roundAmount(input.amount)
  const head = await createDomainRecord(ctx, actor, 'accGlJournals', {
    companyId: input.companyId,
    date: input.postingDate,
    postingDate: input.postingDate,
    remarks: input.summary,
  }, { allowAggregateHead: true, permissionChecked: true })
  const lines = input.income
    ? [
        { accountId: input.ledgerAccountId, debit: rounded, credit: '0' },
        { accountId: input.counterAccountId, debit: '0', credit: rounded },
      ]
    : [
        { accountId: input.counterAccountId, debit: rounded, credit: '0' },
        { accountId: input.ledgerAccountId, debit: '0', credit: rounded },
      ]
  for (const [index, line] of lines.entries()) {
    await createDomainRecord(ctx, actor, 'accGlJournalLines', {
      idx: index + 1,
      debit: line.debit,
      credit: line.credit,
      partyType: null,
      partyId: null,
      remarks: input.summary,
      journalId: head.id,
      accountId: line.accountId,
    }, { permissionChecked: true })
  }
  await patchDomainComputed(ctx, actor, 'accGlJournals', String(head.id), {
    debitTotal: rounded,
    creditTotal: rounded,
  }, 'quickReconcilePrepare')
  await postGlInMutation(asDomainMutationCtx(ctx), {
    type: 'acc.gl_journal',
    id: String(head.id),
    no: String(head.voucherNo),
    companyId: input.companyId,
    postingDate: input.postingDate,
  }, lines.map((line) => ({
    accountId: line.accountId as Id<'accounts'>,
    debit: line.debit,
    credit: line.credit,
  })))
  return patchDomainStatus(ctx, actor, 'accGlJournals', String(head.id), 'AUDITED', 'audit')
}

export const remaining = authedQuery({
  args: { bankTransactionId: v.string(), journalId: v.string() },
  returns: v.object({ amount: v.string() }),
  handler: async (ctx, args) => ({
    amount: await remainingAmount(ctx, ctx.actor, args.bankTransactionId, args.journalId),
  }),
})

export const quickCreate = authedMutation({
  args: {
    bankTransactionId: v.string(),
    counterAccountId: v.string(),
    amount: v.string(),
    summary: v.optional(v.union(v.string(), v.null())),
    postingDate: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requirePermission(ctx.actor, 'acc.bank_transaction:reconcile')
    const transaction = await loadClosure(ctx, 'financeDocuments', TRANSACTION, args.bankTransactionId)
    requireCompany(ctx.actor, transaction.companyId)
    const reconciliationAmount = new Decimal(roundAmount(amount(args.amount, 'amount', { positive: true })))
    const postingDate = dateOnly(args.postingDate)
    const summary = optionalText(args.summary, 'summary', 255)
    const { ledgerAccountId } = await bankLedgerAccount(ctx, transaction)
    if (args.counterAccountId === ledgerAccountId) {
      throw validationError('快速对账参数不合法', { counterAccountId: ['对方科目不能是银行账户绑定的科目'] })
    }
    const accountKey = ctx.db.normalizeId('accounts', args.counterAccountId)
    const account = accountKey ? await ctx.db.get(accountKey) : null
    if (!account || String(account.companyId) !== transaction.companyId || account.isGroup || !account.active) {
      throw validationError('快速对账参数不合法', { counterAccountId: ['科目须属于同一公司、启用且非汇总科目'] })
    }
    const remaining = transactionAmount(transaction).sub(await reconciledTotal(ctx, args.bankTransactionId))
    if (reconciliationAmount.gt(remaining)) {
      throw validationError('快速对账参数不合法', { amount: [`超过流水未对账金额(剩余 ${remaining.toString()})`] })
    }
    const journal = await createQuickJournal(ctx, ctx.actor, {
      companyId: String(transaction.companyId),
      ledgerAccountId,
      counterAccountId: args.counterAccountId,
      income: transaction.income != null,
      amount: reconciliationAmount,
      summary,
      postingDate,
    })
    return createBankReconciliation(ctx, ctx.actor, args.bankTransactionId, String(journal.id), roundAmount(reconciliationAmount))
  },
})
