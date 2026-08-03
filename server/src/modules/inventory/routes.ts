/**
 * 库存域 REST：挂载于 /inventory（对齐 OpenAPI / server-go）。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import { dateIso, datetimeIso } from './helpers.ts'
import type { MaterialCategoryService } from './category-service.ts'
import type { MaterialService } from './material-service.ts'
import type { MaterialUnitService } from './material-unit-service.ts'
import type { WarehouseService } from './warehouse-service.ts'
import type { StockDocService } from './stock-doc-service.ts'
import type { StockTransferService } from './stock-transfer-service.ts'
import type { StockCountService } from './stock-count-service.ts'
import type { StockEntryService } from './stock-entry-service.ts'

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
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await categories.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(categoryDto) })
        },
      )
      .post(
        '/material-categories',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await categories.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(categoryDto(item))
        },
      )
      .patch(
        '/material-categories/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await categories.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 物料 ——
      .post(
        '/materials/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await materials.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(materialDto) })
        },
      )
      .post(
        '/materials',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await materials.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(materialDto(item))
        },
      )
      .patch(
        '/materials/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await materials.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 物料单位转换 ——
      .post(
        '/material-units/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await materialUnits.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(materialUnitDto) })
        },
      )
      .post(
        '/material-units',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await materialUnits.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(materialUnitDto(item))
        },
      )
      .patch(
        '/material-units/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await materialUnits.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 仓库 ——
      .post(
        '/warehouses/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await warehouses.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(warehouseDto) })
        },
      )
      // 静态路径须先于 /warehouses/:id
      .post(
        '/warehouses/outsourced/query',
        zValidator(
          'json',
          z
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
              partyType: z.enum(['SUPPLIER', 'COMPANY']),
              partyId: z.string().uuid(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const result = await warehouses.listOutsourced(
            c.get('actor')!,
            body.partyType,
            body.partyId,
            toList(body),
          )
          return c.json({ count: result.count, results: result.results.map(warehouseDto) })
        },
      )
      .post(
        '/warehouses/seed-defaults',
        zValidator(
          'json',
          z.object({ companyId: z.string().uuid() }).strict(),
          validationHook,
        ),
        async (c) => {
          const count = await warehouses.seedDefaults(
            c.get('actor')!,
            c.req.valid('json').companyId,
          )
          return c.json({ count })
        },
      )
      .post(
        '/warehouses',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await warehouses.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(warehouseDto(item))
        },
      )
      .patch(
        '/warehouses/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await warehouses.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 库存分录 / 余额 ——
      .post(
        '/stock-entries/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockEntries.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(entryDto) })
        },
      )
      .get(
        '/stock-entries/:id',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockEntries.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(entryDto(item))
        },
      )
      .post(
        '/stock-balance/query',
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
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockDocs.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(stockDocDto) })
        },
      )
      .post(
        '/stock-docs',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .patch(
        '/stock-docs/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockDocs.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-docs/:id/audit',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.audit(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .post(
        '/stock-docs/:id/void',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.void(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocDto(item))
        },
      )
      .post(
        '/stock-doc-items/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockDocs.queryItems(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(stockDocItemDto) })
        },
      )
      .post(
        '/stock-doc-items',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockDocs.getItem(c.get('actor')!, c.req.valid('param').id)
          return c.json(stockDocItemDto(item))
        },
      )
      .patch(
        '/stock-doc-items/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockDocs.removeItem(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 调拨单 ——
      .post(
        '/stock-transfers/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockTransfers.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(transferDto) })
        },
      )
      .post(
        '/stock-transfers',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(transferDto(item))
        },
      )
      .patch(
        '/stock-transfers/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockTransfers.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-transfers/:id/ship',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.ship(c.get('actor')!, c.req.valid('param').id)
          return c.json(transferDto(item))
        },
      )
      .post(
        '/stock-transfers/:id/receive',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockTransfers.getItem(c.get('actor')!, c.req.valid('param').id)
          return c.json(transferItemDto(item))
        },
      )
      .patch(
        '/stock-transfer-items/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockTransfers.removeItem(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 盘点单 ——
      .post(
        '/stock-counts/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockCounts.list(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(countDto) })
        },
      )
      .post(
        '/stock-counts',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.get(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .patch(
        '/stock-counts/:id',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await stockCounts.remove(c.get('actor')!, c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/stock-counts/:id/refresh',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.refresh(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-counts/:id/approve',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.approve(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-counts/:id/cancel',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.cancel(c.get('actor')!, c.req.valid('param').id)
          return c.json(countDto(item))
        },
      )
      .post(
        '/stock-count-items/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await stockCounts.queryItems(c.get('actor')!, toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(countItemDto) })
        },
      )
      .post(
        '/stock-count-items',
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await stockCounts.getItem(c.get('actor')!, c.req.valid('param').id)
          return c.json(countItemDto(item))
        },
      )
      .patch(
        '/stock-count-items/:id',
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
    // 物料主数据投影(list/get 均 join inv_material):前端物料富单元格四字段
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    customerPartNo: item.customerPartNo,
    insertedAt: item.insertedAt.toISOString(),
  }
}
