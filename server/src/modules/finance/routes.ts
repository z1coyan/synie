/**
 * 增值税发票 REST：/finance/vat-invoices/*
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { VatInvoice, VatInvoiceService, VatInvoiceUpdateInput } from './invoice-service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().uuid() })

const directionEnum = z.enum(['INBOUND', 'OUTBOUND', 'inbound', 'outbound'])
const partyTypeEnum = z.enum([
  'SUPPLIER',
  'CUSTOMER',
  'COMPANY',
  'EMPLOYEE',
  'supplier',
  'customer',
  'company',
  'employee',
])
const kindEnum = z.enum([
  'SPECIAL',
  'NORMAL',
  'ELECTRONIC_SPECIAL',
  'ELECTRONIC_NORMAL',
  'DIGITAL_SPECIAL',
  'DIGITAL_NORMAL',
  'special',
  'normal',
  'electronic_special',
  'electronic_normal',
  'digital_special',
  'digital_normal',
])

const createSchema = z
  .object({
    companyId: z.string().uuid(),
    direction: directionEnum,
    partyType: partyTypeEnum,
    partyId: z.string().uuid(),
    invoiceKind: kindEnum,
    docNo: z.string().nullable().optional(),
    invoiceDate: z.string().nullable().optional(),
    invoiceCode: z.string().nullable().optional(),
    invoiceNo: z.string().nullable().optional(),
    sellerName: z.string().nullable().optional(),
    sellerTaxNo: z.string().nullable().optional(),
    sellerAddressPhone: z.string().nullable().optional(),
    sellerBankAccount: z.string().nullable().optional(),
    buyerName: z.string().nullable().optional(),
    buyerTaxNo: z.string().nullable().optional(),
    buyerAddressPhone: z.string().nullable().optional(),
    buyerBankAccount: z.string().nullable().optional(),
    items: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    netTotal: z.string().nullable().optional(),
    taxTotal: z.string().nullable().optional(),
    grossTotal: z.string().nullable().optional(),
    issuer: z.string().nullable().optional(),
    reviewer: z.string().nullable().optional(),
    payee: z.string().nullable().optional(),
    remarks: z.string().nullable().optional(),
    partyAccountId: z.string().uuid().nullable().optional(),
    amountAccountId: z.string().uuid().nullable().optional(),
    taxAccountId: z.string().uuid().nullable().optional(),
    mirrorInvoiceId: z.string().uuid().nullable().optional(),
    salReconciliationId: z.string().uuid().nullable().optional(),
    purReconciliationId: z.string().uuid().nullable().optional(),
  })
  .strict()

const updateSchema = z
  .object({
    direction: directionEnum.optional(),
    partyType: partyTypeEnum.optional(),
    partyId: z.string().uuid().optional(),
    invoiceKind: kindEnum.optional(),
    docNo: z.string().nullable().optional(),
    invoiceDate: z.string().nullable().optional(),
    invoiceCode: z.string().nullable().optional(),
    invoiceNo: z.string().nullable().optional(),
    sellerName: z.string().nullable().optional(),
    sellerTaxNo: z.string().nullable().optional(),
    sellerAddressPhone: z.string().nullable().optional(),
    sellerBankAccount: z.string().nullable().optional(),
    buyerName: z.string().nullable().optional(),
    buyerTaxNo: z.string().nullable().optional(),
    buyerAddressPhone: z.string().nullable().optional(),
    buyerBankAccount: z.string().nullable().optional(),
    items: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    netTotal: z.string().nullable().optional(),
    taxTotal: z.string().nullable().optional(),
    grossTotal: z.string().nullable().optional(),
    issuer: z.string().nullable().optional(),
    reviewer: z.string().nullable().optional(),
    payee: z.string().nullable().optional(),
    remarks: z.string().nullable().optional(),
    partyAccountId: z.string().uuid().nullable().optional(),
    amountAccountId: z.string().uuid().nullable().optional(),
    taxAccountId: z.string().uuid().nullable().optional(),
    mirrorInvoiceId: z.string().uuid().nullable().optional(),
    salReconciliationId: z.string().uuid().nullable().optional(),
    purReconciliationId: z.string().uuid().nullable().optional(),
  })
  .strict()

const auditSchema = z
  .object({
    postingDate: z.string().nullable().optional(),
  })
  .strict()

const reverseSchema = z
  .object({
    postingDate: z.string().min(1),
    redInvoiceNo: z.string().nullable().optional(),
  })
  .strict()

const ocrSchema = z
  .object({
    fileId: z.string().uuid(),
  })
  .strict()

function requirePerm(code: string) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
}

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

function invoiceDto(item: VatInvoice) {
  return {
    id: item.id,
    docNo: item.docNo,
    direction: item.direction,
    invoiceDate: item.invoiceDate,
    postingDate: item.postingDate,
    partyType: item.partyType,
    partyId: item.partyId,
    invoiceKind: item.invoiceKind,
    invoiceCode: item.invoiceCode,
    invoiceNo: item.invoiceNo,
    sellerName: item.sellerName,
    sellerTaxNo: item.sellerTaxNo,
    sellerAddressPhone: item.sellerAddressPhone,
    sellerBankAccount: item.sellerBankAccount,
    buyerName: item.buyerName,
    buyerTaxNo: item.buyerTaxNo,
    buyerAddressPhone: item.buyerAddressPhone,
    buyerBankAccount: item.buyerBankAccount,
    items: item.items,
    netTotal: item.netTotal,
    taxTotal: item.taxTotal,
    grossTotal: item.grossTotal,
    issuer: item.issuer,
    reviewer: item.reviewer,
    payee: item.payee,
    remarks: item.remarks,
    redInvoiceNo: item.redInvoiceNo,
    status: item.status,
    auditedAt: item.auditedAt,
    insertedAt: item.insertedAt,
    updatedAt: item.updatedAt,
    companyId: item.companyId,
    partyAccountId: item.partyAccountId,
    amountAccountId: item.amountAccountId,
    taxAccountId: item.taxAccountId,
    mirrorInvoiceId: item.mirrorInvoiceId,
    salReconciliationId: item.salReconciliationId,
    purReconciliationId: item.purReconciliationId,
    createdById: item.createdById,
    auditedById: item.auditedById,
  }
}

function toUpdateInput(
  body: z.infer<typeof updateSchema>,
  raw: Record<string, unknown>,
): VatInvoiceUpdateInput {
  return {
    direction: body.direction,
    partyType: body.partyType,
    partyId: body.partyId,
    invoiceKind: body.invoiceKind,
    docNo: body.docNo,
    docNoPresent: present(raw, 'docNo'),
    invoiceDate: body.invoiceDate,
    invoiceDatePresent: present(raw, 'invoiceDate'),
    invoiceCode: body.invoiceCode,
    invoiceCodePresent: present(raw, 'invoiceCode'),
    invoiceNo: body.invoiceNo,
    invoiceNoPresent: present(raw, 'invoiceNo'),
    sellerName: body.sellerName,
    sellerNamePresent: present(raw, 'sellerName'),
    sellerTaxNo: body.sellerTaxNo,
    sellerTaxNoPresent: present(raw, 'sellerTaxNo'),
    sellerAddressPhone: body.sellerAddressPhone,
    sellerAddressPhonePresent: present(raw, 'sellerAddressPhone'),
    sellerBankAccount: body.sellerBankAccount,
    sellerBankAccountPresent: present(raw, 'sellerBankAccount'),
    buyerName: body.buyerName,
    buyerNamePresent: present(raw, 'buyerName'),
    buyerTaxNo: body.buyerTaxNo,
    buyerTaxNoPresent: present(raw, 'buyerTaxNo'),
    buyerAddressPhone: body.buyerAddressPhone,
    buyerAddressPhonePresent: present(raw, 'buyerAddressPhone'),
    buyerBankAccount: body.buyerBankAccount,
    buyerBankAccountPresent: present(raw, 'buyerBankAccount'),
    items: body.items ?? undefined,
    itemsPresent: present(raw, 'items'),
    netTotal: body.netTotal,
    netTotalPresent: present(raw, 'netTotal'),
    taxTotal: body.taxTotal,
    taxTotalPresent: present(raw, 'taxTotal'),
    grossTotal: body.grossTotal,
    grossTotalPresent: present(raw, 'grossTotal'),
    issuer: body.issuer,
    issuerPresent: present(raw, 'issuer'),
    reviewer: body.reviewer,
    reviewerPresent: present(raw, 'reviewer'),
    payee: body.payee,
    payeePresent: present(raw, 'payee'),
    remarks: body.remarks,
    remarksPresent: present(raw, 'remarks'),
    partyAccountId: body.partyAccountId,
    partyAccountIdPresent: present(raw, 'partyAccountId'),
    amountAccountId: body.amountAccountId,
    amountAccountIdPresent: present(raw, 'amountAccountId'),
    taxAccountId: body.taxAccountId,
    taxAccountIdPresent: present(raw, 'taxAccountId'),
    mirrorInvoiceId: body.mirrorInvoiceId,
    mirrorInvoiceIdPresent: present(raw, 'mirrorInvoiceId'),
    salReconciliationId: body.salReconciliationId,
    salReconciliationIdPresent: present(raw, 'salReconciliationId'),
    purReconciliationId: body.purReconciliationId,
    purReconciliationIdPresent: present(raw, 'purReconciliationId'),
  }
}

export function vatInvoiceRoutes(deps: {
  auth: AuthService
  invoices: VatInvoiceService
}) {
  const { auth, invoices } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('acc.vat_invoice:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await invoices.list(c.get('actor')!, toList(c.req.valid('json')))
        return c.json({
          count: result.count,
          results: result.results.map(invoiceDto),
        })
      },
    )
    .get(
      '/:id',
      requirePerm('acc.vat_invoice:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await invoices.get(c.get('actor')!, c.req.valid('param').id)
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/',
      requirePerm('acc.vat_invoice:create'),
      zValidator('json', createSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await invoices.create(c.get('actor')!, {
          companyId: body.companyId,
          direction: body.direction,
          partyType: body.partyType,
          partyId: body.partyId,
          invoiceKind: body.invoiceKind,
          docNo: body.docNo,
          invoiceDate: body.invoiceDate,
          invoiceCode: body.invoiceCode,
          invoiceNo: body.invoiceNo,
          sellerName: body.sellerName,
          sellerTaxNo: body.sellerTaxNo,
          sellerAddressPhone: body.sellerAddressPhone,
          sellerBankAccount: body.sellerBankAccount,
          buyerName: body.buyerName,
          buyerTaxNo: body.buyerTaxNo,
          buyerAddressPhone: body.buyerAddressPhone,
          buyerBankAccount: body.buyerBankAccount,
          items: body.items,
          netTotal: body.netTotal,
          taxTotal: body.taxTotal,
          grossTotal: body.grossTotal,
          issuer: body.issuer,
          reviewer: body.reviewer,
          payee: body.payee,
          remarks: body.remarks,
          partyAccountId: body.partyAccountId,
          amountAccountId: body.amountAccountId,
          taxAccountId: body.taxAccountId,
          mirrorInvoiceId: body.mirrorInvoiceId,
          salReconciliationId: body.salReconciliationId,
          purReconciliationId: body.purReconciliationId,
        })
        return c.json(invoiceDto(item), 201)
      },
    )
    .patch(
      '/:id',
      requirePerm('acc.vat_invoice:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await invoices.update(
          c.get('actor')!,
          c.req.valid('param').id,
          toUpdateInput(body, raw),
        )
        return c.json(invoiceDto(item))
      },
    )
    .delete(
      '/:id',
      requirePerm('acc.vat_invoice:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await invoices.remove(c.get('actor')!, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      requirePerm('acc.vat_invoice:audit'),
      zValidator('param', idParam, validationHook),
      zValidator('json', auditSchema, validationHook),
      async (c) => {
        const postingDate = c.req.valid('json').postingDate ?? ''
        const item = await invoices.audit(
          c.get('actor')!,
          c.req.valid('param').id,
          postingDate ?? '',
        )
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/:id/void',
      requirePerm('acc.vat_invoice:void'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await invoices.void(c.get('actor')!, c.req.valid('param').id)
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/:id/reverse',
      requirePerm('acc.vat_invoice:reverse'),
      zValidator('param', idParam, validationHook),
      zValidator('json', reverseSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await invoices.reverse(c.get('actor')!, c.req.valid('param').id, {
          postingDate: body.postingDate,
          redInvoiceNo: body.redInvoiceNo,
        })
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/ocr',
      requirePerm('acc.vat_invoice:create'),
      zValidator('json', ocrSchema, validationHook),
      async (c) => {
        const result = await invoices.ocr(c.get('actor')!, c.req.valid('json').fileId)
        return c.json(result)
      },
    )
}
