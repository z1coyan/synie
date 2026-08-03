import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { EntryService } from './entry-service.ts'
import type { Journal, JournalLine, JournalService } from './journal-service.ts'

const idParam = z.object({ id: z.string().uuid() })

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
    debit: z.string(),
    credit: z.string(),
    partyType: z.enum(['SUPPLIER', 'CUSTOMER', 'COMPANY', 'EMPLOYEE']).nullable().optional(),
    partyId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const lineUpdateSchema = z
  .object({
    idx: z.number().int().optional(),
    accountId: z.string().uuid().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    partyType: z.enum(['SUPPLIER', 'CUSTOMER', 'COMPANY', 'EMPLOYEE']).nullable().optional(),
    partyId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

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
  journals: JournalService
  entries: EntryService
}) {
  const { auth, journals, entries } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    // ── 凭证 ──────────────────────────────────────────
    .post(
      '/gl-journals/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await journals.list(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(journalDto) })
      },
    )
    .post(
      '/gl-journals',
      zValidator('json', journalCreateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await journals.create(c.get('actor'), {
          voucherNo: body.voucherNo,
          date: body.date,
          postingDate: body.postingDate,
          remarks: body.remarks,
          companyId: body.companyId,
        })
        return c.json(journalDto(item), 201)
      },
    )
    .get(
      '/gl-journals/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await journals.get(c.get('actor'), c.req.valid('param').id)
        return c.json(journalDto(item))
      },
    )
    .patch(
      '/gl-journals/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', journalUpdateSchema, validationHook),
      async (c) => {
        const raw = c.req.valid('json') as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await journals.update(c.get('actor'), c.req.valid('param').id, {
          voucherNo: body.voucherNo,
          date: body.date,
          postingDate: body.postingDate,
          postingDatePresent: present(raw, 'postingDate'),
          remarks: body.remarks,
          remarksPresent: present(raw, 'remarks'),
        })
        return c.json(journalDto(item))
      },
    )
    .delete(
      '/gl-journals/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await journals.remove(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/gl-journals/:id/audit',
      zValidator('param', idParam, validationHook),
      zValidator('json', journalAuditSchema, validationHook),
      async (c) => {
        const item = await journals.audit(
          c.get('actor'),
          c.req.valid('param').id,
          c.req.valid('json').postingDate,
        )
        return c.json(journalDto(item))
      },
    )
    .post(
      '/gl-journals/:id/cancel',
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await journals.cancel(c.get('actor'), c.req.valid('param').id)
        return c.json(journalDto(item))
      },
    )
    // ── 凭证行 ────────────────────────────────────────
    .post(
      '/gl-journal-lines/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await journals.listLines(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(lineDto) })
      },
    )
    .post(
      '/gl-journal-lines',
      zValidator('json', lineCreateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await journals.createLine(c.get('actor'), {
          journalId: body.journalId,
          idx: body.idx,
          accountId: body.accountId,
          debit: body.debit,
          credit: body.credit,
          partyType: body.partyType,
          partyId: body.partyId,
          remarks: body.remarks,
        })
        return c.json(lineDto(item), 201)
      },
    )
    .get(
      '/gl-journal-lines/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await journals.getLine(c.get('actor'), c.req.valid('param').id)
        return c.json(lineDto(item))
      },
    )
    .patch(
      '/gl-journal-lines/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', lineUpdateSchema, validationHook),
      async (c) => {
        const raw = c.req.valid('json') as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await journals.updateLine(c.get('actor'), c.req.valid('param').id, {
          idx: body.idx,
          accountId: body.accountId,
          debit: body.debit,
          credit: body.credit,
          partyType: body.partyType,
          partyTypePresent: present(raw, 'partyType'),
          partyId: body.partyId,
          partyIdPresent: present(raw, 'partyId'),
          remarks: body.remarks,
          remarksPresent: present(raw, 'remarks'),
        })
        return c.json(lineDto(item))
      },
    )
    .delete(
      '/gl-journal-lines/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await journals.removeLine(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    // ── 总账分录 ──────────────────────────────────────
    .post(
      '/gl-entries/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await entries.list(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(entryDto) })
      },
    )
    .get(
      '/gl-entries/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await entries.get(c.get('actor'), c.req.valid('param').id)
        return c.json(entryDto(item))
      },
    )
    // ── 应收应付报表 ──────────────────────────────────
    .get(
      '/ar-ap-report',
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
        const result = await entries.report(c.get('actor'), {
          companyId: companyId!.trim(),
          asOf: asOf!.trim(),
        })
        return c.json(result)
      },
    )
}
