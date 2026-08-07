/**
 * 库存域主数据 REST：物料分类/物料/物料单位转换/仓库。
 * 挂载于 /base（供应链主数据归入基础资料前缀；库存单据仍挂 /inventory）。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 单位转换无独立权限点（via 物料）：写路径按「持 create 或 update 均可」用 guard 的 `anyOf`，
 * 码从 `authz.targetOf(资源).prefix` 拼，不写字面量。
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
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import { CATEGORY_RESOURCE, type MaterialCategoryService } from './category-service.ts'
import { MATERIAL_RESOURCE, type MaterialService } from './material-service.ts'
import { MATERIAL_UNIT_RESOURCE, type MaterialUnitService } from './material-unit-service.ts'
import { WAREHOUSE_RESOURCE, type WarehouseService } from './warehouse-service.ts'

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

export interface InventoryMasterRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  categories: MaterialCategoryService
  materials: MaterialService
  materialUnits: MaterialUnitService
  warehouses: WarehouseService
}

export function inventoryMasterRoutes(deps: InventoryMasterRouteDeps) {
  const { auth, authz, categories, materials, materialUnits, warehouses } = deps
  const categoryGuard = (action: string) => authz.guard(CATEGORY_RESOURCE, action)
  const materialGuard = (action: string) => authz.guard(MATERIAL_RESOURCE, action)
  const warehouseGuard = (action: string) => authz.guard(WAREHOUSE_RESOURCE, action)
  /** 附加码从 meta 解析的前缀拼，不写字面量权限码 */
  const codeOf = (resource: string, action: string) =>
    `${authz.targetOf(resource).prefix}:${action}`
  const materialUnitGuard = (action: string, anyOf?: readonly string[]) =>
    authz.guard(MATERIAL_UNIT_RESOURCE, action, anyOf ? { anyOf } : undefined)
  /** 单位转换写路径：物料 update ∨ create（删除是 update ∨ delete），与迁移前逐字一致 */
  const unitWriteAnyOf = (second: 'create' | 'delete') => [
    codeOf(MATERIAL_UNIT_RESOURCE, 'update'),
    codeOf(MATERIAL_UNIT_RESOURCE, second),
  ]

  return (
    new Hono<AppEnv>()
      .use('*', requireAuth(auth))
      // —— 物料分类 ——
      .post(
        '/material-categories/query',
        categoryGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await categories.list(permitOf(c), toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(categoryDto) })
        },
      )
      .post(
        '/material-categories',
        categoryGuard('create'),
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
          const item = await categories.create(permitOf(c), c.req.valid('json'))
          return c.json(categoryDto(item), 201)
        },
      )
      .get(
        '/material-categories/:id',
        categoryGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await categories.get(permitOf(c), c.req.valid('param').id)
          return c.json(categoryDto(item))
        },
      )
      .patch(
        '/material-categories/:id',
        categoryGuard('update'),
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
          const item = await categories.update(permitOf(c), c.req.valid('param').id, {
            ...body,
            parentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'parentId'),
          })
          return c.json(categoryDto(item))
        },
      )
      .delete(
        '/material-categories/:id',
        categoryGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await categories.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 物料 ——
      .post(
        '/materials/query',
        materialGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await materials.list(permitOf(c), toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(materialDto) })
        },
      )
      .post(
        '/materials',
        materialGuard('create'),
        zValidator(
          'json',
          z
            .object({
              name: z.string().min(1),
              materialType: z.enum(['STOCK', 'VIRTUAL', 'ASSET']).optional(),
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
          const item = await materials.create(permitOf(c), c.req.valid('json'))
          return c.json(materialDto(item), 201)
        },
      )
      .get(
        '/materials/:id',
        materialGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await materials.get(permitOf(c), c.req.valid('param').id)
          return c.json(materialDto(item))
        },
      )
      .patch(
        '/materials/:id',
        materialGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              name: z.string().min(1).optional(),
              materialType: z.enum(['STOCK', 'VIRTUAL', 'ASSET']).optional(),
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
          const item = await materials.update(permitOf(c), c.req.valid('param').id, {
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
        materialGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await materials.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 物料单位转换 ——
      .post(
        '/material-units/query',
        materialUnitGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await materialUnits.list(permitOf(c), toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(materialUnitDto) })
        },
      )
      .post(
        '/material-units',
        materialUnitGuard('update', unitWriteAnyOf('create')),
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
          const item = await materialUnits.create(permitOf(c), c.req.valid('json'))
          return c.json(materialUnitDto(item), 201)
        },
      )
      .get(
        '/material-units/:id',
        materialUnitGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await materialUnits.get(permitOf(c), c.req.valid('param').id)
          return c.json(materialUnitDto(item))
        },
      )
      .patch(
        '/material-units/:id',
        materialUnitGuard('update', unitWriteAnyOf('create')),
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
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          )
          return c.json(materialUnitDto(item))
        },
      )
      .delete(
        '/material-units/:id',
        materialUnitGuard('update', unitWriteAnyOf('delete')),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await materialUnits.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 仓库 ——
      .post(
        '/warehouses/query',
        warehouseGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await warehouses.list(permitOf(c), toList(c.req.valid('json')))
          return c.json({ count: result.count, results: result.results.map(warehouseDto) })
        },
      )
      // 静态路径须先于 /warehouses/:id
      .post(
        '/warehouses/outsourced/query',
        warehouseGuard('read'),
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
            permitOf(c),
            body.partyType,
            body.partyId,
            toList(body),
          )
          return c.json({ count: result.count, results: result.results.map(warehouseDto) })
        },
      )
      .post(
        '/warehouses/seed-defaults',
        warehouseGuard('create'),
        zValidator(
          'json',
          z.object({ companyId: z.string().uuid() }).strict(),
          validationHook,
        ),
        async (c) => {
          const count = await warehouses.seedDefaults(
            permitOf(c),
            c.req.valid('json').companyId,
          )
          return c.json({ count })
        },
      )
      .post(
        '/warehouses',
        warehouseGuard('create'),
        zValidator(
          'json',
          z
            .object({
              // 编码由系统按编号规则生成；传入非空值由 service 一律 422
              code: z.string().min(1).nullish(),
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
          const item = await warehouses.create(permitOf(c), c.req.valid('json'))
          return c.json(warehouseDto(item), 201)
        },
      )
      .get(
        '/warehouses/:id',
        warehouseGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await warehouses.get(permitOf(c), c.req.valid('param').id)
          return c.json(warehouseDto(item))
        },
      )
      .patch(
        '/warehouses/:id',
        warehouseGuard('update'),
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
          const item = await warehouses.update(permitOf(c), c.req.valid('param').id, {
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
        warehouseGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await warehouses.remove(permitOf(c), c.req.valid('param').id)
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
    materialType: item.materialType,
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
    code: item.code,
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
