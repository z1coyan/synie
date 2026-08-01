import { v } from 'convex/values'
import { authedMutation } from '../../lib/auth'
import { synieError } from '../../lib/errors'
import { defineClosureRecordApi } from '../shared/api'
import { createDomainRecord, removeDomainRecord, updateDomainRecord } from '../shared/records'
import {
  createBankAccountRecord,
  createBankTransactionRecord,
  removeBankAccountRecord,
  removeBankReconciliation,
  removeBankTransactionRecord,
  updateBankAccountRecord,
  updateBankTransactionRecord,
} from './banking'

const resources = [
  'accVatInvoices', 'accBankAccounts', 'accBankTransactions', 'accBankImportTemplates',
  'accBankImports', 'accBankImportItems', 'accBankReconciliations',
  'accExpenseReports', 'accExpenseReportItems', 'accBills', 'accBillTransactions', 'accBillHoldings',
] as const
const allowed = new Set<string>(resources)
const resource = (value: string): string => {
  if (!allowed.has(value)) throw synieError('validation', `资源 ${value} 不属于财务事务闭包`)
  return value
}

const reads = defineClosureRecordApi(resources)
export const get = reads.get
export const list = reads.list

export const create = authedMutation({
  args: { resource: v.string(), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => {
    const selected = resource(args.resource)
    if (selected === 'accBankAccounts') return createBankAccountRecord(ctx, ctx.actor, args.input)
    if (selected === 'accBankTransactions') return createBankTransactionRecord(ctx, ctx.actor, args.input)
    return createDomainRecord(ctx, ctx.actor, selected, args.input)
  },
})

export const update = authedMutation({
  args: { resource: v.string(), id: v.string(), input: v.any() }, returns: v.any(),
  handler: (ctx, args) => {
    const selected = resource(args.resource)
    if (selected === 'accBankAccounts') return updateBankAccountRecord(ctx, ctx.actor, args.id, args.input)
    if (selected === 'accBankTransactions') return updateBankTransactionRecord(ctx, ctx.actor, args.id, args.input)
    return updateDomainRecord(ctx, ctx.actor, selected, args.id, args.input)
  },
})

export const remove = authedMutation({
  args: { resource: v.string(), id: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const selected = resource(args.resource)
    if (selected === 'accBankAccounts') await removeBankAccountRecord(ctx, ctx.actor, args.id)
    else if (selected === 'accBankTransactions') await removeBankTransactionRecord(ctx, ctx.actor, args.id)
    else if (selected === 'accBankReconciliations') await removeBankReconciliation(ctx, ctx.actor, args.id)
    else await removeDomainRecord(ctx, ctx.actor, selected, args.id)
    return null
  },
})
