/**
 * 库存域主数据 REST：物料单位转换/仓库。
 * 挂载于 /base（供应链主数据归入基础资料前缀；库存单据仍挂 /inventory）。
 *
 * 物料本体与物料分类已迁 `platform/standard`，端点由 `standardRoutes` 在
 * `/base/materials`、`/base/material-categories` 派生。
 * 单位转换服务也已派生（standard child），但**路由留手写**：写路径的
 * 「持 create 或 update 均可」anyOf 语义（旧 requireAnyPermission）标准路由表达不了。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
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
import { decimalStringSchema, listQuerySchema, validationHook } from '~/platform/http/zod.ts'
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
  materialUnits: MaterialUnitService
  warehouses: WarehouseService
}

export function inventoryMasterRoutes(deps: InventoryMasterRouteDeps) {
  const { auth, authz, materialUnits, warehouses } = deps
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
              // 十进制形状在 wire 挡住（服务派生的 decimal 归一不接受非法串）
              factor: decimalStringSchema,
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
              factor: decimalStringSchema.optional(),
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
