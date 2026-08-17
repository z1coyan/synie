/**
 * 会计域 REST：凭证 / 凭证行 / 总账分录 / 应收应付报表。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 工作流 audit/cancel 各挂自己的码（meta 已声明）；凭证行是 via(凭证头)，动作码解析到母单前缀。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { decimalStringSchema, listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import { GL_ENTRY_RESOURCE_NAME, type EntryService } from './entry-service.ts'
import {
  JOURNAL_LINE_RESOURCE_NAME,
  JOURNAL_RESOURCE_NAME,
  type Journal,
  type JournalLine,
  type JournalService,
} from './journal-service.ts'

const journalCreateSchema = z
  .object({
    voucherNo: z.string().nullable().optional(),
    date: z.string().min(1),
    postingDate: z.string().nullable().optional(),
    remarks: z.string().nullable().optional(),
    companyId: z.string().uuid(),
  })
  .strict()

const journalUpdateSchema = z
  .object({
    voucherNo: z.string().optional(),
    date: z.string().optional(),
    postingDate: z.string().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const journalAuditSchema = z
  .object({
    postingDate: z.string().nullable().optional(),
  })
  .strict()

const lineCreateSchema = z
  .object({
    journalId: z.string().uuid(),
    idx: z.number().int(),
    accountId: z.string().uuid(),
    debit: decimalStringSchema,
    credit: decimalStringSchema,
    partyType: z.enum(['SUPPLIER', 'CUSTOMER', 'COMPANY', 'EMPLOYEE']).nullable().optional(),
    partyId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const lineUpdateSchema = z
  .object({
    idx: z.number().int().optional(),
    accountId: z.string().uuid().optional(),
    debit: decimalStringSchema.optional(),
    credit: decimalStringSchema.optional(),
    partyType: z.enum(['SUPPLIER', 'CUSTOMER', 'COMPANY', 'EMPLOYEE']).nullable().optional(),
    partyId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

function journalDto(item: Journal) {
  return {
    id: item.id,
    voucherNo: item.voucherNo,
    date: item.date,
    postingDate: item.postingDate,
    remarks: item.remarks,
    status: item.status,
    submittedAt: item.submittedAt ? item.submittedAt.toISOString() : null,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    companyId: item.companyId,
    createdById: item.createdById,
    submittedById: item.submittedById,
    debitTotal: item.debitTotal,
    creditTotal: item.creditTotal,
    company: item.company,
    createdBy: item.createdBy,
    submittedBy: item.submittedBy,
  }
}

function lineDto(item: JournalLine) {
  return {
    id: item.id,
    idx: item.idx,
    debit: item.debit,
    credit: item.credit,
    partyType: item.partyType,
    partyId: item.partyId,
    remarks: item.remarks,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    journalId: item.journalId,
    companyId: item.companyId,
    accountId: item.accountId,
    currencyId: item.currencyId,
    journal: item.journal,
    company: item.company,
    account: item.account,
    currency: item.currency,
  }
}

function entryDto(item: Awaited<ReturnType<EntryService['get']>>) {
  return {
    id: item.id,
    seq: item.seq,
    postingDate: item.postingDate,
    debit: item.debit,
    credit: item.credit,
    partyType: item.partyType,
    partyId: item.partyId,
    voucherType: item.voucherType,
    voucherId: item.voucherId,
    voucherNo: item.voucherNo,
    isCancelled: item.isCancelled,
    isReversed: item.isReversed,
    isReversal: item.isReversal,
    remarks: item.remarks,
    insertedAt: item.insertedAt.toISOString(),
    companyId: item.companyId,
    accountId: item.accountId,
    currencyId: item.currencyId,
  }
}

export function accountingRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  journals: JournalService
  entries: EntryService
}) {
  const { auth, authz, journals, entries } = deps
  const journalGuard = (action: string) => authz.guard(JOURNAL_RESOURCE_NAME, action)
  const lineGuard = (action: string) => authz.guard(JOURNAL_LINE_RESOURCE_NAME, action)
  const entryGuard = (action: string) => authz.guard(GL_ENTRY_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    // ── 凭证 ──────────────────────────────────────────
    .post(
      '/gl-journals/query',
      journalGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await journals.list(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(journalDto) })
      },
    )
    .post(
      '/gl-journals',
      journalGuard('create'),
      zValidator('json', journalCreateSchema, validationHook),
      async (c) => {
        const item = await journals.create(permitOf(c), c.req.valid('json'))
        return c.json(journalDto(item), 201)
      },
    )
    .get(
      '/gl-journals/:id',
      journalGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await journals.get(permitOf(c), c.req.valid('param').id)
        return c.json(journalDto(item))
      },
    )
    .patch(
      '/gl-journals/:id',
      journalGuard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', journalUpdateSchema, validationHook),
      // present-key 语义：键出现即写（null 清空），缺省不动——内核 normalizeInput 原生支持
      async (c) => {
        const item = await journals.update(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(journalDto(item))
      },
    )
    .delete(
      '/gl-journals/:id',
      journalGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await journals.remove(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/gl-journals/:id/audit',
      journalGuard('audit'),
      zValidator('param', idParam, validationHook),
      zValidator('json', journalAuditSchema, validationHook),
      async (c) => {
        const item = await journals.audit(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json').postingDate,
        )
        return c.json(journalDto(item))
      },
    )
    .post(
      '/gl-journals/:id/cancel',
      journalGuard('cancel'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await journals.cancel(permitOf(c), c.req.valid('param').id)
        return c.json(journalDto(item))
      },
    )
    // ── 凭证行 ────────────────────────────────────────
    .post(
      '/gl-journal-lines/query',
      lineGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await journals.listLines(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(lineDto) })
      },
    )
    .post(
      '/gl-journal-lines',
      lineGuard('create'),
      zValidator('json', lineCreateSchema, validationHook),
      async (c) => {
        const item = await journals.createLine(permitOf(c), c.req.valid('json'))
        return c.json(lineDto(item), 201)
      },
    )
    .get(
      '/gl-journal-lines/:id',
      lineGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await journals.getLine(permitOf(c), c.req.valid('param').id)
        return c.json(lineDto(item))
      },
    )
    .patch(
      '/gl-journal-lines/:id',
      lineGuard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', lineUpdateSchema, validationHook),
      async (c) => {
        const item = await journals.updateLine(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(lineDto(item))
      },
    )
    .delete(
      '/gl-journal-lines/:id',
      lineGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await journals.removeLine(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    // ── 总账分录 ──────────────────────────────────────
    .post(
      '/gl-entries/query',
      entryGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await entries.list(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(entryDto) })
      },
    )
    .get(
      '/gl-entries/:id',
      entryGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await entries.get(permitOf(c), c.req.valid('param').id)
        return c.json(entryDto(item))
      },
    )
    // ── 应收应付报表 ──────────────────────────────────
    .get(
      '/ar-ap-report',
      entryGuard('read'),
      async (c) => {
        const companyId = c.req.query('companyId')
        const asOf = c.req.query('asOf')
        const fields: Record<string, string[]> = {}
        if (!companyId || companyId.trim() === '') fields.companyId = ['必填']
        else if (!/^[0-9a-f-]{36}$/i.test(companyId.trim())) fields.companyId = ['必须是 UUID']
        if (!asOf || asOf.trim() === '') fields.asOf = ['必填']
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf.trim())) {
          fields.asOf = ['必须是 YYYY-MM-DD 日期']
        }
        if (Object.keys(fields).length > 0) {
          throw ApiError.validation('应收应付报表参数不合法', fields)
        }
        const result = await entries.report(permitOf(c), {
          companyId: companyId!.trim(),
          asOf: asOf!.trim(),
        })
        return c.json(result)
      },
    )
    .get(
      '/ar-ap-party-ledger',
      entryGuard('read'),
      async (c) => {
        const companyId = c.req.query('companyId')
        const asOf = c.req.query('asOf')
        const side = c.req.query('side')
        const partyType = c.req.query('partyType')
        const partyId = c.req.query('partyId')
        const partyNil = c.req.query('partyNil')
        const fields: Record<string, string[]> = {}
        if (!companyId || companyId.trim() === '') fields.companyId = ['必填']
        else if (!/^[0-9a-f-]{36}$/i.test(companyId.trim())) fields.companyId = ['必须是 UUID']
        if (!asOf || asOf.trim() === '') fields.asOf = ['必填']
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf.trim())) {
          fields.asOf = ['必须是 YYYY-MM-DD 日期']
        }
        if (side !== 'ar' && side !== 'ap') fields.side = ['必须是 ar 或 ap']
        const nil = partyNil === 'true' || partyNil === '1'
        if (!nil) {
          if (!partyType || partyType.trim() === '') fields.partyType = ['必填']
          if (!partyId || partyId.trim() === '') fields.partyId = ['必填']
          else if (!/^[0-9a-f-]{36}$/i.test(partyId.trim())) fields.partyId = ['必须是 UUID']
        }
        if (Object.keys(fields).length > 0) {
          throw ApiError.validation('往来明细参数不合法', fields)
        }
        const result = await entries.partyLedger(permitOf(c), {
          companyId: companyId!.trim(),
          asOf: asOf!.trim(),
          side: side as 'ar' | 'ap',
          partyType: nil ? null : partyType!.trim(),
          partyId: nil ? null : partyId!.trim(),
          partyNil: nil,
        })
        return c.json(result)
      },
    )
}
