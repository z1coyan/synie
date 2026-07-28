/**
 * 库存域 REST：挂载于 /inventory（对齐 OpenAPI / server-go）。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { hasPermission, requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import { dateIso, datetimeIso } from './helpers.ts'
import type { MaterialCategoryService } from './category-service.ts'
import type { MaterialService } from './material-service.ts'
import type { MaterialUnitService } from './material-unit-service.ts'
import type { WarehouseService } from './warehouse-service.ts'
import type { StockDocService } from './stock-doc-service.ts'
import type { StockTransferService } from './stock-transfer-service.ts'
import type { StockCountService } from './stock-count-service.ts'
import type { StockEntryService } from './stock-entry-service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({
        column: z.string(),
        direction: z.enum(['ascending', 'descending']),
      })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().uuid() })

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

function requirePerm(code: string) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
}

function requireAnyPerm(...codes: string[]) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    const actor = c.get('actor')
    if (!codes.some((code) => hasPermission(actor, code))) {
      requirePermission(actor, codes[0]!)
    }
    await next()
  }
}

export interface InventoryRouteDeps {
  auth: AuthService
  categories: MaterialCategoryService
  materials: MaterialService
  materialUnits: MaterialUnitService
  warehouses: WarehouseService
  stockDocs: StockDocService
  stockTransfers: StockTransferService
  stockCounts: StockCountService
  stockEntries: StockEntryService
}

export function inventoryRoutes(deps: InventoryRouteDeps) {
  const {
    auth,
    categories,
    materials,
    materialUnits,
    warehouses,
    stockDocs,
    stockTransfers,
    stockCounts,
    stockEntries,
  } = deps

  return (
    new Hono<AppEnv>()
      .use('*', requireAuth(auth))
      // —— 物料分类 ——
      .post(
        '/material-categories/query',
        requirePerm('inv.material_category:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await categories.list(toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(categoryDto) })
        },
      )
      .post(
        '/material-categories',
        requirePerm('inv.material_category:create'),
        zValidator(
          'json',
          z
            .object({
              code: z.string().min(1),
              name: z.string().min(1),
              isLeaf: z.boolean().optional(),
              active: z.boolean().optional(),
              parentId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await categories.create(c.get('actor')!, c.req.valid('json'))
          return c.json(categoryDto(item), 201)
        },
      )
      .get(
        '/material-categories/:id',
        requirePerm('inv.material_category:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await categories.get(c.req.valid('param').id)
          return c.json(categoryDto(item))
        },
      )
      .patch(
        '/material-categories/:id',
        requirePerm('inv.material_category:update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              code: z.string().min(1).optional(),
              name: z.string().min(1).optional(),
              isLeaf: z.boolean().optional(),
              active: z.boolean().optional(),
              parentId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await categories.update(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            parentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'parentId'),
          })
          return c.json(categoryDto(item))
        },
      )
      .delete(
        '/material-categories/:id',
        requirePerm('inv.material_category:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await categories.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 物料 ——
      .post(
        '/materials/query',
        requirePerm('inv.material:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await materials.list(toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(materialDto) })
        },
      )
      .post(
        '/materials',
        requirePerm('inv.material:create'),
        zValidator(
          'json',
          z
            .object({
              name: z.string().min(1),
              spec: z.string().nullable().optional(),
              customerPartNo: z.string().nullable().optional(),
              isCustomerMaterial: z.boolean().optional(),
              active: z.boolean().optional(),
              categoryId: z.string().uuid(),
              defaultUnitId: z.string().uuid(),
              customerId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await materials.create(c.get('actor')!, c.req.valid('json'))
          return c.json(materialDto(item), 201)
        },
      )
      .get(
        '/materials/:id',
        requirePerm('inv.material:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await materials.get(c.req.valid('param').id)
          return c.json(materialDto(item))
        },
      )
      .patch(
        '/materials/:id',
        requirePerm('inv.material:update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              name: z.string().min(1).optional(),
              spec: z.string().nullable().optional(),
              customerPartNo: z.string().nullable().optional(),
              isCustomerMaterial: z.boolean().optional(),
              active: z.boolean().optional(),
              categoryId: z.string().uuid().optional(),
              defaultUnitId: z.string().uuid().optional(),
              customerId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await materials.update(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            specPresent: Object.prototype.hasOwnProperty.call(raw, 'spec'),
            customerPartNoPresent: Object.prototype.hasOwnProperty.call(raw, 'customerPartNo'),
            customerIdPresent: Object.prototype.hasOwnProperty.call(raw, 'customerId'),
          })
          return c.json(materialDto(item))
        },
      )
      .delete(
        '/materials/:id',
        requirePerm('inv.material:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await materials.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 物料单位转换 ——
      .post(
        '/material-units/query',
        requirePerm('inv.material:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await materialUnits.list(toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(materialUnitDto) })
        },
      )
      .post(
        '/material-units',
        requireAnyPerm('inv.material:update', 'inv.material:create'),
        zValidator(
          'json',
          z
            .object({
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              factor: z.string().min(1),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await materialUnits.create(c.get('actor')!, c.req.valid('json'))
          return c.json(materialUnitDto(item), 201)
        },
      )
      .get(
        '/material-units/:id',
        requirePerm('inv.material:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await materialUnits.get(c.req.valid('param').id)
          return c.json(materialUnitDto(item))
        },
      )
      .patch(
        '/material-units/:id',
        requireAnyPerm('inv.material:update', 'inv.material:create'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              unitId: z.string().uuid().optional(),
              factor: z.string().min(1).optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await materialUnits.update(
            c.get('actor')!,
            c.req.valid('param').id,
            c.req.valid('json'),
          )
          return c.json(materialUnitDto(item))
        },
      )
      .delete(
        '/material-units/:id',
        requireAnyPerm('inv.material:update', 'inv.material:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await materialUnits.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 仓库 ——
      .post(
        '/warehouses/query',
        requirePerm('inv.warehouse:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await warehouses.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(warehouseDto) })
        },
      )
      .post(
        '/warehouses',
        requirePerm('inv.warehouse:create'),
        zValidator(
          'json',
          z
            .object({
              name: z.string().min(1),
              isLeaf: z.boolean().optional(),
              active: z.boolean().optional(),
              isOutsourced: z.boolean().optional(),
              partyType: z.string().nullable().optional(),
              partyId: z.string().uuid().nullable().optional(),
              allowNegative: z.boolean().optional(),
              companyId: z.string().uuid(),
              parentId: z.string().uuid().nullable().optional(),
              accountId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await warehouses.create(c.get('actor')!, c.req.valid('json'))
          return c.json(warehouseDto(item), 201)
        },
      )
      .get(
        '/warehouses/:id',
        requirePerm('inv.warehouse:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await warehouses.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(warehouseDto(item))
        },
      )
      .patch(
        '/warehouses/:id',
        requirePerm('inv.warehouse:update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              name: z.string().min(1).optional(),
              isLeaf: z.boolean().optional(),
              active: z.boolean().optional(),
              isOutsourced: z.boolean().optional(),
              partyType: z.string().nullable().optional(),
              partyId: z.string().uuid().nullable().optional(),
              allowNegative: z.boolean().optional(),
              parentId: z.string().uuid().nullable().optional(),
              accountId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await warehouses.update(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            partyTypePresent: Object.prototype.hasOwnProperty.call(raw, 'partyType'),
            partyIdPresent: Object.prototype.hasOwnProperty.call(raw, 'partyId'),
            parentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'parentId'),
            accountIdPresent: Object.prototype.hasOwnProperty.call(raw, 'accountId'),
          })
          return c.json(warehouseDto(item))
        },
      )
      .delete(
        '/warehouses/:id',
        requirePerm('inv.warehouse:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await warehouses.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 库存分录 / 余额 ——
      .post(
        '/stock-entries/query',
        requirePerm('inv.stock_entry:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockEntries.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(entryDto) })
        },
      )
      .get(
        '/stock-entries/:id',
        requirePerm('inv.stock_entry:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockEntries.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(entryDto(item))
        },
      )
      .post(
        '/stock-balance/query',
        requirePerm('inv.stock_entry:read'),
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
          const results = await stockEntries.balance(c.get('actor')!, c.req.valid('json'))
          return c.json({ results })
        },
      )
      // —— 手工出入库单 ——
      .post(
        '/stock-docs/query',
        requirePerm('inv.stock_doc:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockDocs.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(stockDocDto) })
        },
      )
      .post(
        '/stock-docs',
        requirePerm('inv.stock_doc:create'),
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
          const item = await stockDocs.create(c.get('actor')!, c.req.valid('json'))
          return c.json(stockDocDto(item), 201)
        },
      )
      .get(
        '/stock-docs/:id',
        requirePerm('inv.stock_doc:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .patch(
        '/stock-docs/:id',
        requirePerm('inv.stock_doc:update'),
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
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await stockDocs.update(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            summaryPresent: Object.prototype.hasOwnProperty.call(raw, 'summary'),
            remarksPresent: Object.prototype.hasOwnProperty.call(raw, 'remarks'),
          })
          return c.json(stockDocDto(item))
        },
      )
      .delete(
        '/stock-docs/:id',
        requirePerm('inv.stock_doc:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockDocs.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-docs/:id/audit',
        requirePerm('inv.stock_doc:audit'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.audit(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .post(
        '/stock-docs/:id/void',
        requirePerm('inv.stock_doc:void'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.void(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .post(
        '/stock-doc-items/query',
        requirePerm('inv.stock_doc:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockDocs.queryItems(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(stockDocItemDto) })
        },
      )
      .post(
        '/stock-doc-items',
        requirePerm('inv.stock_doc:create'),
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
          const item = await stockDocs.createItem(c.get('actor')!, c.req.valid('json'))
          return c.json(stockDocItemDto(item), 201)
        },
      )
      .get(
        '/stock-doc-items/:id',
        requirePerm('inv.stock_doc:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.getItem(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocItemDto(item))
        },
      )
      .patch(
        '/stock-doc-items/:id',
        requirePerm('inv.stock_doc:update'),
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
          const item = await stockDocs.updateItem(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            remarkPresent: Object.prototype.hasOwnProperty.call(raw, 'remark'),
          })
          return c.json(stockDocItemDto(item))
        },
      )
      .delete(
        '/stock-doc-items/:id',
        requirePerm('inv.stock_doc:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockDocs.removeItem(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 调拨单 ——
      .post(
        '/stock-transfers/query',
        requirePerm('inv.stock_transfer:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockTransfers.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(transferDto) })
        },
      )
      .post(
        '/stock-transfers',
        requirePerm('inv.stock_transfer:create'),
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
          const item = await stockTransfers.create(c.get('actor')!, c.req.valid('json'))
          return c.json(transferDto(item), 201)
        },
      )
      .get(
        '/stock-transfers/:id',
        requirePerm('inv.stock_transfer:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(transferDto(item))
        },
      )
      .patch(
        '/stock-transfers/:id',
        requirePerm('inv.stock_transfer:update'),
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
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await stockTransfers.update(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            summaryPresent: Object.prototype.hasOwnProperty.call(raw, 'summary'),
            remarksPresent: Object.prototype.hasOwnProperty.call(raw, 'remarks'),
          })
          return c.json(transferDto(item))
        },
      )
      .delete(
        '/stock-transfers/:id',
        requirePerm('inv.stock_transfer:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockTransfers.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-transfers/:id/ship',
        requirePerm('inv.stock_transfer:ship'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.ship(c.get('actor')!, c.req.valid('param').id)
          return c.json(transferDto(item))
        },
      )
      .post(
        '/stock-transfers/:id/receive',
        requirePerm('inv.stock_transfer:receive'),
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
          const item = await stockTransfers.receive(c.get('actor')!, c.req.valid('param').id, body)
          return c.json(transferDto(item))
        },
      )
      .post(
        '/stock-transfer-items/query',
        requirePerm('inv.stock_transfer:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockTransfers.queryItems(
            c.get('actor')!,
            toList(c.req.valid('json')),
          )
          return c.json({ count: result.count, results: result.results.map(transferItemDto) })
        },
      )
      .post(
        '/stock-transfer-items',
        requirePerm('inv.stock_transfer:create'),
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
          const item = await stockTransfers.createItem(c.get('actor')!, c.req.valid('json'))
          return c.json(transferItemDto(item), 201)
        },
      )
      .get(
        '/stock-transfer-items/:id',
        requirePerm('inv.stock_transfer:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.getItem(c.get('actor')!, c.req.valid('param').id)
          return c.json(transferItemDto(item))
        },
      )
      .patch(
        '/stock-transfer-items/:id',
        requirePerm('inv.stock_transfer:update'),
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
          const item = await stockTransfers.updateItem(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            remarkPresent: Object.prototype.hasOwnProperty.call(raw, 'remark'),
          })
          return c.json(transferItemDto(item))
        },
      )
      .delete(
        '/stock-transfer-items/:id',
        requirePerm('inv.stock_transfer:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockTransfers.removeItem(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 盘点单 ——
      .post(
        '/stock-counts/query',
        requirePerm('inv.stock_count:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockCounts.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(countDto) })
        },
      )
      .post(
        '/stock-counts',
        requirePerm('inv.stock_count:create'),
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
          const item = await stockCounts.create(c.get('actor')!, c.req.valid('json'))
          return c.json(countDto(item), 201)
        },
      )
      .get(
        '/stock-counts/:id',
        requirePerm('inv.stock_count:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .patch(
        '/stock-counts/:id',
        requirePerm('inv.stock_count:update'),
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
          const body = c.req.valid('json')
          const raw = (await c.req.json()) as Record<string, unknown>
          const item = await stockCounts.update(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            summaryPresent: Object.prototype.hasOwnProperty.call(raw, 'summary'),
            remarksPresent: Object.prototype.hasOwnProperty.call(raw, 'remarks'),
          })
          return c.json(countDto(item))
        },
      )
      .delete(
        '/stock-counts/:id',
        requirePerm('inv.stock_count:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockCounts.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-counts/:id/refresh',
        requirePerm('inv.stock_count:update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.refresh(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-counts/:id/approve',
        requirePerm('inv.stock_count:approve'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.approve(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-counts/:id/cancel',
        requirePerm('inv.stock_count:cancel'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.cancel(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-count-items/query',
        requirePerm('inv.stock_count:read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockCounts.queryItems(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(countItemDto) })
        },
      )
      .post(
        '/stock-count-items',
        requirePerm('inv.stock_count:create'),
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
          const item = await stockCounts.createItem(c.get('actor')!, c.req.valid('json'))
          return c.json(countItemDto(item), 201)
        },
      )
      .get(
        '/stock-count-items/:id',
        requirePerm('inv.stock_count:read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.getItem(c.get('actor')!, c.req.valid('param').id)
          return c.json(countItemDto(item))
        },
      )
      .patch(
        '/stock-count-items/:id',
        requirePerm('inv.stock_count:update'),
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
          const item = await stockCounts.updateItem(c.get('actor')!, c.req.valid('param').id, {
            ...body,
            countedQuantityPresent: Object.prototype.hasOwnProperty.call(raw, 'countedQuantity'),
            remarkPresent: Object.prototype.hasOwnProperty.call(raw, 'remark'),
          })
          return c.json(countItemDto(item))
        },
      )
      .delete(
        '/stock-count-items/:id',
        requirePerm('inv.stock_count:delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockCounts.removeItem(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
  )
}

// ─── DTOs ───────────────────────────────────────────────────

function categoryDto(item: Awaited<ReturnType<MaterialCategoryService['get']>>) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    isLeaf: item.isLeaf,
    active: item.active,
    hasChildren: item.hasChildren,
    parentId: item.parentId,
    parent: item.parent,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function materialDto(item: Awaited<ReturnType<MaterialService['get']>>) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    spec: item.spec,
    customerPartNo: item.customerPartNo,
    isCustomerMaterial: item.isCustomerMaterial,
    active: item.active,
    categoryId: item.categoryId,
    defaultUnitId: item.defaultUnitId,
    customerId: item.customerId,
    category: item.category,
    defaultUnit: item.defaultUnit,
    customer: item.customer,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function materialUnitDto(item: Awaited<ReturnType<MaterialUnitService['get']>>) {
  return {
    id: item.id,
    factor: item.factor,
    materialId: item.materialId,
    unitId: item.unitId,
    material: item.material,
    unit: item.unit,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function warehouseDto(item: Awaited<ReturnType<WarehouseService['get']>>) {
  return {
    id: item.id,
    name: item.name,
    isLeaf: item.isLeaf,
    active: item.active,
    isOutsourced: item.isOutsourced,
    partyType: item.partyType,
    partyId: item.partyId,
    allowNegative: item.allowNegative,
    companyId: item.companyId,
    parentId: item.parentId,
    accountId: item.accountId,
    company: item.company,
    parent: item.parent,
    account: item.account,
    hasChildren: item.hasChildren,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

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
    insertedAt: item.insertedAt.toISOString(),
  }
}
