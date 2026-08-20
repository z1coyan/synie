/**
 * 增值税发票 REST：/finance/vat-invoices/*
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 作废走 void；红冲开新红字分录、原单保留，能力折进 create（仅作废不能红冲）。
 * 动作码由 `endInvoiceAction(reverseMode)` 派生。
 * 在本文件派生——两码都已在 meta 的 actions 里声明，故 guard 不会撞 assertActionDeclared。
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
import { listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import {
  VAT_INVOICE_RESOURCE_NAME,
  type VatInvoice,
  type VatInvoiceService,
} from './invoice-service.ts'

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
    // 内核 wire 的 datetime 是 Date，HTTP 面恒 ISO 字符串（与迁移前逐字一致）
    auditedAt: item.auditedAt === null ? null : item.auditedAt.toISOString(),
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
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

/** 作废 → void；红冲 → create（新开红字，不是作废） */
export function endInvoiceAction(reverseMode: boolean): string {
  return reverseMode ? 'create' : 'void'
}

export function vatInvoiceRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  invoices: VatInvoiceService
}) {
  const { auth, authz, invoices } = deps
  const guard = (action: string) => authz.guard(VAT_INVOICE_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await invoices.list(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({
          count: result.count,
          results: result.results.map(invoiceDto),
        })
      },
    )
    .get(
      '/:id',
      guard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await invoices.get(permitOf(c), c.req.valid('param').id)
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/',
      guard('create'),
      zValidator('json', createSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await invoices.create(permitOf(c), {
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
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        // 出现即写、缺省不动：内核 present-key 语义取代旧的 *Present 布尔
        const item = await invoices.update(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json') as Record<string, unknown>,
        )
        return c.json(invoiceDto(item))
      },
    )
    .delete(
      '/:id',
      guard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await invoices.remove(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      guard('audit'),
      zValidator('param', idParam, validationHook),
      zValidator('json', auditSchema, validationHook),
      async (c) => {
        const postingDate = c.req.valid('json').postingDate ?? ''
        const item = await invoices.audit(
          permitOf(c),
          c.req.valid('param').id,
          postingDate ?? '',
        )
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/:id/void',
      guard(endInvoiceAction(false)),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await invoices.void(permitOf(c), c.req.valid('param').id)
        return c.json(invoiceDto(item))
      },
    )
    .post(
      '/:id/reverse',
      guard(endInvoiceAction(true)),
      zValidator('param', idParam, validationHook),
      zValidator('json', reverseSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await invoices.reverse(permitOf(c), c.req.valid('param').id, {
          postingDate: body.postingDate,
          redInvoiceNo: body.redInvoiceNo,
        })
        return c.json(invoiceDto(item))
      },
    )
    // OCR 预填是「为建票读文件」：本资源 create ∧ 文件读（文件行级可达性归平台）
    .post(
      '/ocr',
      guard('create'),
      zValidator('json', ocrSchema, validationHook),
      async (c) => {
        const result = await invoices.ocr(permitOf(c), c.req.valid('json').fileId)
        return c.json(result)
      },
    )
}
