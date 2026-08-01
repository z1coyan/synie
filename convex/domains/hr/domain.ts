import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import { synieError } from '../../lib/errors'
import { createDomainRecord, getDomainRecord, listDomainRecords, removeDomainRecord, updateDomainRecord } from '../shared/records'
import { getProjectedAttendanceDay, listProjectedAttendanceDays } from './attendance'
import {
  createLoanRecord,
  createPaymentRecord,
  createPayrollRecord,
  removeLoanRecord,
  removePaymentRecord,
  removePayrollRecord,
  updateLoanRecord,
  updatePayrollRecord,
} from './payroll'

const resources = [
  'hrAttendancePunches', 'hrAttendanceImports', 'hrAttendanceDays',
  'hrAttendanceCorrections', 'hrPayrolls', 'hrPayrollPayments', 'hrEmployeeLoans',
] as const
const allowed = new Set<string>(resources)
const resource = (value: string): string => {
  if (!allowed.has(value)) throw synieError('validation', `资源 ${value} 不属于人力事务闭包`)
  return value
}

export const get = authedQuery({
  args: { resource: v.string(), id: v.string() }, returns: v.any(),
  handler: (ctx, args) => resource(args.resource) === 'hrAttendanceDays'
    ? getProjectedAttendanceDay(ctx, ctx.actor, args.id)
    : getDomainRecord(ctx, ctx.actor, args.resource, args.id),
})
export const list = authedQuery({
  args: {
    resource: v.string(), numItems: v.number(), cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()), queryArgs: v.optional(v.any()),
  },
  returns: v.any(),
  handler: (ctx, args) => resource(args.resource) === 'hrAttendanceDays'
    ? listProjectedAttendanceDays(ctx, ctx.actor, {
        numItems: args.numItems, cursor: args.cursor, search: args.search, args: args.queryArgs,
      })
    : listDomainRecords(ctx, ctx.actor, args.resource, {
        numItems: args.numItems, cursor: args.cursor, search: args.search, args: args.queryArgs,
      }),
})

export const create = authedMutation({
  args: { resource: v.string(), input: v.any() },
  returns: v.any(),
  handler: (ctx, args) => {
    const selected = resource(args.resource)
    if (selected === 'hrPayrolls') return createPayrollRecord(ctx, ctx.actor, args.input)
    if (selected === 'hrPayrollPayments') return createPaymentRecord(ctx, ctx.actor, args.input)
    if (selected === 'hrEmployeeLoans') return createLoanRecord(ctx, ctx.actor, args.input)
    return createDomainRecord(ctx, ctx.actor, selected, args.input)
  },
})

export const update = authedMutation({
  args: { resource: v.string(), id: v.string(), input: v.any() },
  returns: v.any(),
  handler: (ctx, args) => {
    const selected = resource(args.resource)
    if (selected === 'hrPayrolls') return updatePayrollRecord(ctx, ctx.actor, args.id, args.input)
    if (selected === 'hrEmployeeLoans') return updateLoanRecord(ctx, ctx.actor, args.id, args.input)
    return updateDomainRecord(ctx, ctx.actor, selected, args.id, args.input)
  },
})

export const remove = authedMutation({
  args: { resource: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const selected = resource(args.resource)
    if (selected === 'hrPayrolls') await removePayrollRecord(ctx, ctx.actor, args.id)
    else if (selected === 'hrPayrollPayments') await removePaymentRecord(ctx, ctx.actor, args.id)
    else if (selected === 'hrEmployeeLoans') await removeLoanRecord(ctx, ctx.actor, args.id)
    else await removeDomainRecord(ctx, ctx.actor, selected, args.id)
    return null
  },
})
