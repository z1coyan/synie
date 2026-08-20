/**
 * 库存域单据 REST：挂载于 /inventory（对齐 OpenAPI / server-go）。
 * 主数据（物料/分类/单位转换/仓库）已迁至 master-routes.ts，挂载于 /base。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 动作码唯一事实源是 meta：盘点的 refresh 未声明独立动作，沿用 update 门控。
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
import { dateIso, datetimeIso } from './helpers.ts'
import { DOC_ITEM_RESOURCE, DOC_RESOURCE, type StockDocService } from './stock-doc-service.ts'
import {
  TRANSFER_ITEM_RESOURCE,
  TRANSFER_RESOURCE,
  type StockTransferService,
} from './stock-transfer-service.ts'
import {
  COUNT_ITEM_RESOURCE,
  COUNT_RESOURCE,
  type StockCountService,
} from './stock-count-service.ts'
import { ENTRY_RESOURCE, type StockEntryService } from './stock-entry-service.ts'

export interface InventoryRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  stockDocs: StockDocService
  stockTransfers: StockTransferService
  stockCounts: StockCountService
  stockEntries: StockEntryService
}

export function inventoryRoutes(deps: InventoryRouteDeps) {
  const { auth, authz, stockDocs, stockTransfers, stockCounts, stockEntries } = deps
  const entryGuard = (action: string) => authz.guard(ENTRY_RESOURCE, action)
  const docGuard = (action: string) => authz.guard(DOC_RESOURCE, action)
  const docItemGuard = (action: string) => authz.guard(DOC_ITEM_RESOURCE, action)
  const transferGuard = (action: string) => authz.guard(TRANSFER_RESOURCE, action)
  const transferItemGuard = (action: string) => authz.guard(TRANSFER_ITEM_RESOURCE, action)
  const countGuard = (action: string) => authz.guard(COUNT_RESOURCE, action)
  const countItemGuard = (action: string) => authz.guard(COUNT_ITEM_RESOURCE, action)

  return (
    new Hono<AppEnv>()
      .use('*', requireAuth(auth))
      // —— 库存分录 / 余额 ——
      .post(
        '/stock-entries/query',
        entryGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockEntries.list(permitOf(c), toListQuery(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(entryDto) })
        },
      )
      .get(
        '/stock-entries/:id',
        entryGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockEntries.get(permitOf(c), c.req.valid('param').id)
          return c.json(entryDto(item))
        },
      )
      .post(
        '/stock-balance/query',
        entryGuard('read'),
        zValidator(
          'json',
          z
            .object({
              companyId: z.string().uuid(),
              asOf: z.string().nullable().optional(),
              warehouseId: z.string().uuid().nullable().optional(),
              materialId: z.string().uuid().nullable().optional(),
              hideZero: z.boolean().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const results = await stockEntries.balance(permitOf(c), c.req.valid('json'))
          return c.json({ results })
        },
      )
      // —— 手工出入库单 ——
      .post(
        '/stock-docs/query',
        docGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockDocs.list(permitOf(c), toListQuery(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(stockDocDto) })
        },
      )
      .post(
        '/stock-docs',
        docGuard('create'),
        zValidator(
          'json',
          z
            .object({
              docNo: z.string().nullable().optional(),
              direction: z.enum(['IN', 'OUT']),
              docDate: z.string().nullable().optional(),
              summary: z.string().nullable().optional(),
              remarks: z.string().nullable().optional(),
              companyId: z.string().uuid(),
              warehouseId: z.string().uuid(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await stockDocs.create(permitOf(c), c.req.valid('json'))
          return c.json(stockDocDto(item), 201)
        },
      )
      .get(
        '/stock-docs/:id',
        docGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.get(permitOf(c), c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .patch(
        '/stock-docs/:id',
        docGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              docNo: z.string().optional(),
              direction: z.enum(['IN', 'OUT']).optional(),
              docDate: z.string().optional(),
              summary: z.string().nullable().optional(),
              remarks: z.string().nullable().optional(),
              warehouseId: z.string().uuid().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          // 出现即写、缺省不动：内核 present-key 语义取代旧的 *Present 布尔
          const item = await stockDocs.update(permitOf(c), c.req.valid('param').id, c.req.valid('json'))
          return c.json(stockDocDto(item))
        },
      )
      .delete(
        '/stock-docs/:id',
        docGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockDocs.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-docs/:id/audit',
        docGuard('audit'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.audit(permitOf(c), c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .post(
        '/stock-docs/:id/void',
        docGuard('void'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.void(permitOf(c), c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .post(
        '/stock-doc-items/query',
        docItemGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockDocs.queryItems(permitOf(c), toListQuery(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(stockDocItemDto) })
        },
      )
      .post(
        '/stock-doc-items',
        docItemGuard('create'),
        zValidator(
          'json',
          z
            .object({
              stockDocId: z.string().uuid(),
              idx: z.number().int(),
              qty: z.string().min(1),
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              remark: z.string().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await stockDocs.createItem(permitOf(c), c.req.valid('json'))
          return c.json(stockDocItemDto(item), 201)
        },
      )
      .get(
        '/stock-doc-items/:id',
        docItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.getItem(permitOf(c), c.req.valid('param').id)
          return c.json(stockDocItemDto(item))
        },
      )
      .patch(
        '/stock-doc-items/:id',
        docItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              idx: z.number().int().optional(),
              qty: z.string().optional(),
              materialId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              remark: z.string().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await stockDocs.updateItem(permitOf(c), c.req.valid('param').id, {
            ...body,
            remarkPresent: Object.prototype.hasOwnProperty.call(raw, 'remark'),
          })
          return c.json(stockDocItemDto(item))
        },
      )
      .delete(
        '/stock-doc-items/:id',
        docItemGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockDocs.removeItem(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 调拨单 ——
      .post(
        '/stock-transfers/query',
        transferGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockTransfers.list(permitOf(c), toListQuery(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(transferDto) })
        },
      )
      .post(
        '/stock-transfers',
        transferGuard('create'),
        zValidator(
          'json',
          z
            .object({
              docNo: z.string().nullable().optional(),
              docDate: z.string().nullable().optional(),
              summary: z.string().nullable().optional(),
              remarks: z.string().nullable().optional(),
              companyId: z.string().uuid(),
              fromWarehouseId: z.string().uuid(),
              toWarehouseId: z.string().uuid(),
              transitWarehouseId: z.string().uuid(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await stockTransfers.create(permitOf(c), c.req.valid('json'))
          return c.json(transferDto(item), 201)
        },
      )
      .get(
        '/stock-transfers/:id',
        transferGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.get(permitOf(c), c.req.valid('param').id)
          return c.json(transferDto(item))
        },
      )
      .patch(
        '/stock-transfers/:id',
        transferGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              docNo: z.string().optional(),
              docDate: z.string().optional(),
              summary: z.string().nullable().optional(),
              remarks: z.string().nullable().optional(),
              fromWarehouseId: z.string().uuid().optional(),
              toWarehouseId: z.string().uuid().optional(),
              transitWarehouseId: z.string().uuid().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          // 出现即写、缺省不动：内核 present-key 语义取代旧的 *Present 布尔
          const item = await stockTransfers.update(permitOf(c), c.req.valid('param').id, c.req.valid('json'))
          return c.json(transferDto(item))
        },
      )
      .delete(
        '/stock-transfers/:id',
        transferGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockTransfers.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-transfers/:id/ship',
        transferGuard('audit'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.ship(permitOf(c), c.req.valid('param').id)
          return c.json(transferDto(item))
        },
      )
      .post(
        '/stock-transfers/:id/receive',
        transferGuard('audit'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              receipts: z
                .array(
                  z
                    .object({
                      itemId: z.string().uuid(),
                      qty: z.string().min(1),
                    })
                    .strict(),
                )
                .optional()
                .nullable(),
            })
            .strict()
            .optional()
            .default({}),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json') ?? {}
          const item = await stockTransfers.receive(permitOf(c), c.req.valid('param').id, body)
          return c.json(transferDto(item))
        },
      )
      .post(
        '/stock-transfer-items/query',
        transferItemGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockTransfers.queryItems(
            permitOf(c),
            toListQuery(c.req.valid('json')),
          )
          return c.json({ count: result.count, results: result.results.map(transferItemDto) })
        },
      )
      .post(
        '/stock-transfer-items',
        transferItemGuard('create'),
        zValidator(
          'json',
          z
            .object({
              stockTransferId: z.string().uuid(),
              idx: z.number().int(),
              qty: z.string().min(1),
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              remark: z.string().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await stockTransfers.createItem(permitOf(c), c.req.valid('json'))
          return c.json(transferItemDto(item), 201)
        },
      )
      .get(
        '/stock-transfer-items/:id',
        transferItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.getItem(permitOf(c), c.req.valid('param').id)
          return c.json(transferItemDto(item))
        },
      )
      .patch(
        '/stock-transfer-items/:id',
        transferItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              idx: z.number().int().optional(),
              qty: z.string().optional(),
              materialId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              remark: z.string().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await stockTransfers.updateItem(permitOf(c), c.req.valid('param').id, {
            ...body,
            remarkPresent: Object.prototype.hasOwnProperty.call(raw, 'remark'),
          })
          return c.json(transferItemDto(item))
        },
      )
      .delete(
        '/stock-transfer-items/:id',
        transferItemGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockTransfers.removeItem(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 盘点单 ——
      .post(
        '/stock-counts/query',
        countGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockCounts.list(permitOf(c), toListQuery(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(countDto) })
        },
      )
      .post(
        '/stock-counts',
        countGuard('create'),
        zValidator(
          'json',
          z
            .object({
              docNo: z.string().nullable().optional(),
              postingDate: z.string().nullable().optional(),
              summary: z.string().nullable().optional(),
              remarks: z.string().nullable().optional(),
              companyId: z.string().uuid(),
              warehouseId: z.string().uuid(),
              loadAll: z.boolean().optional(),
              items: z
                .array(
                  z
                    .object({
                      materialId: z.string().uuid(),
                      unitId: z.string().uuid(),
                      countedQuantity: z.string().nullable().optional(),
                      remark: z.string().nullable().optional(),
                    })
                    .strict(),
                )
                .optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await stockCounts.create(permitOf(c), c.req.valid('json'))
          return c.json(countDto(item), 201)
        },
      )
      .get(
        '/stock-counts/:id',
        countGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.get(permitOf(c), c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .patch(
        '/stock-counts/:id',
        countGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              docNo: z.string().optional(),
              postingDate: z.string().optional(),
              summary: z.string().nullable().optional(),
              remarks: z.string().nullable().optional(),
              warehouseId: z.string().uuid().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          // 出现即写、缺省不动：内核 present-key 语义取代旧的 *Present 布尔
          const item = await stockCounts.update(permitOf(c), c.req.valid('param').id, c.req.valid('json'))
          return c.json(countDto(item))
        },
      )
      .delete(
        '/stock-counts/:id',
        countGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockCounts.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-counts/:id/refresh',
        countGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.refresh(permitOf(c), c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-counts/:id/approve',
        countGuard('audit'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.approve(permitOf(c), c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-counts/:id/cancel',
        countGuard('void'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.cancel(permitOf(c), c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-count-items/query',
        countItemGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockCounts.queryItems(permitOf(c), toListQuery(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(countItemDto) })
        },
      )
      .post(
        '/stock-count-items',
        countItemGuard('create'),
        zValidator(
          'json',
          z
            .object({
              countId: z.string().uuid(),
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              countedQuantity: z.string().nullable().optional(),
              remark: z.string().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await stockCounts.createItem(permitOf(c), c.req.valid('json'))
          return c.json(countItemDto(item), 201)
        },
      )
      .get(
        '/stock-count-items/:id',
        countItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.getItem(permitOf(c), c.req.valid('param').id)
          return c.json(countItemDto(item))
        },
      )
      .patch(
        '/stock-count-items/:id',
        countItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              materialId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              countedQuantity: z.string().nullable().optional(),
              remark: z.string().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await stockCounts.updateItem(permitOf(c), c.req.valid('param').id, {
            ...body,
            countedQuantityPresent: Object.prototype.hasOwnProperty.call(raw, 'countedQuantity'),
            remarkPresent: Object.prototype.hasOwnProperty.call(raw, 'remark'),
          })
          return c.json(countItemDto(item))
        },
      )
      .delete(
        '/stock-count-items/:id',
        countItemGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockCounts.removeItem(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
  )
}

// ─── DTOs ───────────────────────────────────────────────────

function stockDocDto(item: Awaited<ReturnType<StockDocService['get']>>) {
  return {
    id: item.id,
    docNo: item.docNo,
    direction: item.direction,
    docDate: dateIso(item.docDate),
    summary: item.summary,
    remarks: item.remarks,
    status: item.status,
    auditedAt: datetimeIso(item.auditedAt),
    companyId: item.companyId,
    warehouseId: item.warehouseId,
    createdById: item.createdById,
    auditedById: item.auditedById,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function stockDocItemDto(item: Awaited<ReturnType<StockDocService['getItem']>>) {
  return {
    id: item.id,
    idx: item.idx,
    qty: item.qty,
    baseQty: item.baseQty,
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    unitName: item.unitName,
    remark: item.remark,
    stockDocId: item.stockDocId,
    companyId: item.companyId,
    materialId: item.materialId,
    unitId: item.unitId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function transferDto(item: Awaited<ReturnType<StockTransferService['get']>>) {
  return {
    id: item.id,
    docNo: item.docNo,
    docDate: dateIso(item.docDate),
    summary: item.summary,
    remarks: item.remarks,
    status: item.status,
    shippedAt: datetimeIso(item.shippedAt),
    receivedAt: datetimeIso(item.receivedAt),
    companyId: item.companyId,
    fromWarehouseId: item.fromWarehouseId,
    toWarehouseId: item.toWarehouseId,
    transitWarehouseId: item.transitWarehouseId,
    createdById: item.createdById,
    shippedById: item.shippedById,
    receivedById: item.receivedById,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function transferItemDto(item: Awaited<ReturnType<StockTransferService['getItem']>>) {
  return {
    id: item.id,
    idx: item.idx,
    qty: item.qty,
    baseQty: item.baseQty,
    receivedQty: item.receivedQty,
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    unitName: item.unitName,
    remark: item.remark,
    stockTransferId: item.stockTransferId,
    companyId: item.companyId,
    materialId: item.materialId,
    unitId: item.unitId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function countDto(item: Awaited<ReturnType<StockCountService['get']>>) {
  return {
    id: item.id,
    docNo: item.docNo,
    postingDate: dateIso(item.postingDate),
    summary: item.summary,
    remarks: item.remarks,
    status: item.status,
    auditedAt: datetimeIso(item.auditedAt),
    snapshotTakenAt: item.snapshotTakenAt.toISOString(),
    companyId: item.companyId,
    warehouseId: item.warehouseId,
    createdById: item.createdById,
    auditedById: item.auditedById,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function countItemDto(item: Awaited<ReturnType<StockCountService['getItem']>>) {
  return {
    id: item.id,
    countedQuantity: item.countedQuantity,
    convertedCounted: item.convertedCounted,
    bookQuantity: item.bookQuantity,
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    unitName: item.unitName,
    remark: item.remark,
    countId: item.countId,
    companyId: item.companyId,
    materialId: item.materialId,
    unitId: item.unitId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function entryDto(item: Awaited<ReturnType<StockEntryService['get']>>) {
  return {
    id: item.id,
    seq: item.seq,
    quantity: item.quantity,
    postingDate: dateIso(item.postingDate),
    voucherType: item.voucherType,
    voucherId: item.voucherId,
    voucherNo: item.voucherNo,
    isCancelled: item.isCancelled,
    cancelledAt: datetimeIso(item.cancelledAt),
    remarks: item.remarks,
    companyId: item.companyId,
    warehouseId: item.warehouseId,
    materialId: item.materialId,
    // 物料主数据投影(list/get 均 join inv_material):前端物料富单元格四字段
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    customerPartNo: item.customerPartNo,
    insertedAt: item.insertedAt.toISOString(),
  }
}
