import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import {
  idParam,
  standardChildRoutes,
  standardRoutes,
  type StandardGuardOverride,
  type StandardRouteEndpoint,
  type StandardRouteService,
} from '~/platform/standard/routes.ts'
import type { StandardItem } from '~/platform/standard/service.ts'
import { MATERIAL_RESOURCE } from '~/modules/inventory/material-service.ts'
import { DEMAND_ITEM_RESOURCE, DEMAND_RESOURCE, type DemandService } from './demand-service.ts'
import {
  BOM_BYPRODUCT_RESOURCE,
  BOM_COMPONENT_RESOURCE,
  BOM_RESOURCE,
  BOM_ROUTE_RESOURCE,
  OPERATION_RESOURCE,
  TEMPLATE_ITEM_RESOURCE,
  TEMPLATE_RESOURCE,
  type MasterService,
} from './master-service.ts'
import { MOLD_DESIGN_RESOURCE, type MoldDesignService } from './mold-design-service.ts'
import {
  OUTPUT_ITEM_RESOURCE,
  OUTPUT_RESOURCE,
  type OutputService,
} from './output-service.ts'
import { WORK_ORDER_RESOURCE, type WorkOrderService } from './work-order-service.ts'
import {
  bomRouteWire,
  bomWire,
  demandItemWire,
  demandWire,
  listWire,
  moldDesignWire,
  occupancyWire,
  outputItemWire,
  outputWire,
  workOrderWire,
} from './wire.ts'

/** 流程单据（需求/工单/入库）的列表查询仍手写：companyId 是公司域资源的扩展键 */
const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    companyId: z.string().uuid().optional(),
  })
  .strict()

const moldDesignCreate = z
  .object({
    name: z.string().min(1).max(128),
    spec: z.string().max(128).nullable().optional(),
    moldType: z.enum(['STAMPING', 'FORMING', 'POSITIONING', 'OTHER']),
    unitId: z.string().uuid(),
  })
  .strict()

const moldDesignUpdate = z
  .object({
    name: z.string().min(1).max(128).optional(),
    spec: z.string().max(128).nullable().optional(),
    moldType: z.enum(['STAMPING', 'FORMING', 'POSITIONING', 'OTHER']).optional(),
    unitId: z.string().uuid().optional(),
  })
  .strict()

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> & {
  companyId?: string
} {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
    companyId: body.companyId,
  }
}

function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

export interface ManufacturingRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  registry: Registry
  master: MasterService
  demands: DemandService
  workOrders: WorkOrderService
  outputs: OutputService
  moldDesigns: MoldDesignService
}

/**
 * 挂载于 /manufacturing。
 *
 * 平坦主数据（工序 / 工艺模板 / BOM 头与子行 / 模具设计读与删）由 `platform/standard`
 * 派生：zod 与 DTO 自 meta 派生（与既有手写 wire 逐字对齐），guard 超词表部分经
 * `guards` 端点级覆盖声明（子行写 anyOf、模具连带写物料 allOf），不再整域手写。
 * 按动作弹射保留手写的端点（同路径先注册胜出，见各子路由注释）：
 * - BOM create（status 双写形 + 同事务建后启用）、activate/deactivate/apply-route-template
 * - 模具设计 create/update（写面跨模具+物料两实体，meta 表达不了）
 * 需求编排（履约需求单安排/指派）与工单/入库流程整段手写——它们是流程不是平坦 CRUD。
 *
 * 手写端点逐个挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 跨资源门控用 guard 的 allOf（附加码从 `authz.targetOf(资源).prefix` 拼，不写字面量）：
 * 从需求行建工单要 `mfg.demand:read`、入库行引用工单要 `mfg.work_order:read`、
 * 工单内嵌建 BOM 要 `mfg.bom:create`、模具设计连带写物料要 `base.material:*`、
 * BOM 套用工艺模板要 `mfg.route_template:read`——范围取格上最小，来源单据行级可达性一并成立。
 * 子行 create「持 create 或 update 均可」用 guard 的 anyOf（旧 requireCreateOrUpdate 已删）。
 */
export function manufacturingRoutes(deps: ManufacturingRouteDeps) {
  const { auth, authz, registry, master, demands, workOrders, outputs, moldDesigns } = deps
  const demandGuard = (action: string, options?: { allOf?: readonly string[] }) =>
    authz.guard(DEMAND_RESOURCE, action, options)
  const demandItemGuard = (action: string) => authz.guard(DEMAND_ITEM_RESOURCE, action)
  const workOrderGuard = (action: string, options?: { allOf?: readonly string[] }) =>
    authz.guard(WORK_ORDER_RESOURCE, action, options)
  const outputGuard = (action: string) => authz.guard(OUTPUT_RESOURCE, action)
  const outputItemGuard = (action: string, options?: { allOf?: readonly string[] }) =>
    authz.guard(OUTPUT_ITEM_RESOURCE, action, options)
  /** 附加码从 meta 解析的前缀拼，不写字面量权限码 */
  const codeOf = (resource: string, action: string) =>
    `${authz.targetOf(resource).prefix}:${action}`
  const bomGuard = (action: string, options?: { allOf?: readonly string[] }) =>
    authz.guard(BOM_RESOURCE, action, options)
  /** 模具设计与物料 1:1：每次写模具必然连带写物料，故声明式 allOf 同名动作码 */
  const moldGuard = (action: string, material?: 'create' | 'update' | 'delete') =>
    authz.guard(
      MOLD_DESIGN_RESOURCE,
      action,
      material ? { allOf: [codeOf(MATERIAL_RESOURCE, material)] } : undefined,
    )
  /** 子行写：持归宿的 update 或 create 均可（对齐迁移前 requireCreateOrUpdate） */
  const childWriteGuards = (
    resource: string,
  ): Partial<Record<StandardRouteEndpoint, StandardGuardOverride>> => ({
    create: {
      action: 'update',
      options: { anyOf: [codeOf(resource, 'update'), codeOf(resource, 'create')] },
    },
    delete: { action: 'update' },
  })

  // —— 模具设计：读/删派生；create/update 写面跨模具+物料两实体（name/spec/unitId 是
  // 物料列），meta 派生 schema 表达不了，按动作弹射保留手写（先注册，同路径胜出）——
  const moldStandard: StandardRouteService = {
    stampedColumns: new Set(),
    get: async (permit, id) => (await moldDesigns.get(permit, id)) as unknown as StandardItem,
    list: async (permit, query) => {
      const result = await moldDesigns.list(permit, query)
      return {
        count: result.count,
        results: result.results.map((item) => item as unknown as StandardItem),
      }
    },
    create: async (permit, input) =>
      (await moldDesigns.create(
        permit,
        input as { name: string; spec?: string | null; moldType: string; unitId: string },
      )) as unknown as StandardItem,
    update: async (permit, id, patch) =>
      (await moldDesigns.update(permit, id, {
        name: patch.name as string | undefined,
        spec: patch.spec as string | null | undefined,
        specPresent: present(patch, 'spec'),
        moldType: patch.moldType as string | undefined,
        unitId: patch.unitId as string | undefined,
      })) as unknown as StandardItem,
    remove: (permit, id) => moldDesigns.remove(permit, id),
    bulkUpdate: async (permit, ids, patch) => {
      const items: StandardItem[] = []
      for (const id of [...new Set(ids)]) {
        items.push((await moldStandard.update(permit, id, patch)) as StandardItem)
      }
      return items
    },
    bulkRemove: async (permit, ids) => {
      const unique = [...new Set(ids)]
      for (const id of unique) await moldDesigns.remove(permit, id)
      return unique.length
    },
  }
  /** 写模具必连带写物料：allOf 物料同名动作码（与手写 moldGuard 同一事实） */
  const moldWriteAllOf = (material: 'create' | 'update' | 'delete') => ({
    options: { allOf: [codeOf(MATERIAL_RESOURCE, material)] },
  })
  const moldDesignRoutes = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/',
      moldGuard('create', 'create'),
      zValidator('json', moldDesignCreate, validationHook),
      async (c) => {
        const item = await moldDesigns.create(permitOf(c), c.req.valid('json'))
        return c.json(moldDesignWire(item), 201)
      },
    )
    .patch(
      '/:id',
      moldGuard('update', 'update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', moldDesignUpdate, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await moldDesigns.update(permitOf(c), c.req.valid('param').id, {
          ...body,
          specPresent: present(raw, 'spec'),
        })
        return c.json(moldDesignWire(item))
      },
    )
    .route(
      '/',
      standardRoutes({
        auth,
        authz,
        registry,
        resource: MOLD_DESIGN_RESOURCE,
        service: moldStandard,
        guards: {
          create: moldWriteAllOf('create'),
          update: moldWriteAllOf('update'),
          delete: moldWriteAllOf('delete'),
          bulkUpdate: moldWriteAllOf('update'),
          bulkDelete: moldWriteAllOf('delete'),
        },
      }),
    )

  // —— BOM：query/get/patch/delete 派生；create（status 双写形 + 同事务建后启用）与
  // 启停/套用模板动作按动作弹射保留手写（先注册，同路径胜出）——
  const bomRoutes = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/',
      bomGuard('create'),
      zValidator(
        'json',
        z
          .object({
            code: z.string().max(32).nullable().optional(),
            materialId: z.string().uuid(),
            planName: z.string().max(64).nullable().optional(),
            note: z.string().max(255).nullable().optional(),
            status: z.enum(['DRAFT', 'ACTIVE', 'draft', 'active']).optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const item = await master.createBom(permitOf(c), {
          code: body.code,
          materialId: body.materialId,
          planName: body.planName,
          note: body.note,
          status: body.status
            ? (body.status.toLowerCase() as 'draft' | 'active')
            : undefined,
        })
        return c.json(bomWire(item), 201)
      },
    )
    .post(
      '/:id/activate',
      bomGuard('update'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await master.activateBom(permitOf(c), c.req.valid('param').id)
        return c.json(bomWire(item))
      },
    )
    .post(
      '/:id/deactivate',
      bomGuard('update'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await master.deactivateBom(permitOf(c), c.req.valid('param').id)
        return c.json(bomWire(item))
      },
    )
    .post(
      '/:id/apply-route-template',
      bomGuard('update', { allOf: [codeOf(TEMPLATE_RESOURCE, 'read')] }),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z.object({ templateId: z.string().uuid() }).strict(),
        validationHook,
      ),
      async (c) => {
        const routes = await master.applyRouteTemplate(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json').templateId,
        )
        return c.json({ count: routes.length, results: routes.map(bomRouteWire) })
      },
    )
    .route(
      '/',
      standardRoutes({
        auth,
        authz,
        registry,
        resource: BOM_RESOURCE,
        service: master.standard.boms,
      }),
    )

  return (
    new Hono<AppEnv>()
      .use('*', requireAuth(auth))
      // —— 主数据（standardRoutes 派生，zod/DTO 自 meta）——
      .route(
        '/operations',
        standardRoutes({
          auth,
          authz,
          registry,
          resource: OPERATION_RESOURCE,
          service: master.standard.operations,
        }),
      )
      .route('/mold-designs', moldDesignRoutes)
      .route(
        '/process-templates',
        standardRoutes({
          auth,
          authz,
          registry,
          resource: TEMPLATE_RESOURCE,
          service: master.standard.templates,
        }),
      )
      .route(
        '/process-template-items',
        standardChildRoutes({
          auth,
          authz,
          registry,
          resource: TEMPLATE_ITEM_RESOURCE,
          service: master.standard.templateItems,
          guards: childWriteGuards(TEMPLATE_ITEM_RESOURCE),
        }),
      )
      .route('/boms', bomRoutes)
      .route(
        '/bom-components',
        standardChildRoutes({
          auth,
          authz,
          registry,
          resource: BOM_COMPONENT_RESOURCE,
          service: master.standard.components,
          guards: childWriteGuards(BOM_COMPONENT_RESOURCE),
        }),
      )
      .route(
        '/bom-routes',
        standardChildRoutes({
          auth,
          authz,
          registry,
          resource: BOM_ROUTE_RESOURCE,
          service: master.standard.routes,
          guards: childWriteGuards(BOM_ROUTE_RESOURCE),
        }),
      )
      .route(
        '/bom-byproducts',
        standardChildRoutes({
          auth,
          authz,
          registry,
          resource: BOM_BYPRODUCT_RESOURCE,
          service: master.standard.byproducts,
          guards: childWriteGuards(BOM_BYPRODUCT_RESOURCE),
        }),
      )
      // —— 履约需求（流程，手写）——
      .post(
        '/demands/query',
        demandGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await demands.listDemands(permitOf(c), toList(c.req.valid('json')))
          return c.json(listWire(result, demandWire))
        },
      )
      .post(
        '/demands',
        demandGuard('create'),
        zValidator(
          'json',
          z
            .object({
              companyId: z.string().uuid(),
              demandNo: z.string().max(32).nullable().optional(),
              demandDate: z.string().optional(),
              assignType: z.string().min(1),
              needDate: z.string().nullable().optional(),
              remarks: z.string().max(512).nullable().optional(),
              assignedDeptId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await demands.createDemand(permitOf(c), c.req.valid('json'))
          return c.json(demandWire(item), 201)
        },
      )
      .get(
        '/demands/:id',
        demandGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.getDemand(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/demands/:id',
        demandGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              demandNo: z.string().max(32).optional(),
              demandDate: z.string().optional(),
              assignType: z.string().nullable().optional(),
              needDate: z.string().nullable().optional(),
              remarks: z.string().max(512).nullable().optional(),
              assignedDeptId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await demands.updateDemand(permitOf(c), c.req.valid('param').id, {
            demandNo: body.demandNo,
            demandDate: body.demandDate,
            assignType: body.assignType,
            assignTypePresent: present(raw, 'assignType'),
            needDate: body.needDate,
            needDatePresent: present(raw, 'needDate'),
            remarks: body.remarks,
            remarksPresent: present(raw, 'remarks'),
            assignedDeptId: body.assignedDeptId,
            assignedDeptIdPresent: present(raw, 'assignedDeptId'),
          })
          return c.json(demandWire(item))
        },
      )
      .delete(
        '/demands/:id',
        demandGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await demands.deleteDemand(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/demands/:id/confirm',
        demandGuard('audit'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.confirmDemand(permitOf(c), c.req.valid('param').id))),
      )
      .post(
        '/demands/:id/close',
        demandGuard('audit'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.closeDemand(permitOf(c), c.req.valid('param').id))),
      )
      .post(
        '/demands/:id/void',
        demandGuard('void'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.voidDemand(permitOf(c), c.req.valid('param').id))),
      )
      // 下发/改派：已确认未关闭才可用（状态守卫在服务层抛 conflict）；
      // 可同时改指派类型与下发车间，合并后过联动校验
      .post(
        '/demands/:id/dispatch',
        demandGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              assignType: z.string().optional(),
              assignedDeptId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) =>
          c.json(
            demandWire(
              await demands.dispatchDemand(
                permitOf(c),
                c.req.valid('param').id,
                c.req.valid('json'),
              ),
            ),
          ),
      )
      // —— 需求行 ——
      .post(
        '/demand-items/query',
        demandItemGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const demandId =
            typeof filter?.demandId === 'object' && filter.demandId && 'value' in filter.demandId
              ? String(filter.demandId.value)
              : undefined
          const result = await demands.listDemandItems(permitOf(c), {
            ...toList(body),
            demandId,
          })
          return c.json(listWire(result, demandItemWire))
        },
      )
      .post(
        '/demand-items',
        demandItemGuard('create'),
        zValidator(
          'json',
          z
            .object({
              demandId: z.string().uuid(),
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              salesOrderItemId: z.string().uuid().nullable().optional(),
              idx: z.number().int(),
              qty: z.string().min(1),
              needDate: z.string().min(1),
              fulfillmentMethod: z.string().optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await demands.createDemandItem(permitOf(c), c.req.valid('json'))
          return c.json(demandItemWire(item), 201)
        },
      )
      .get(
        '/demand-items/:id',
        demandItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            demandItemWire(await demands.getDemandItem(permitOf(c), c.req.valid('param').id)),
          ),
      )
      .patch(
        '/demand-items/:id',
        demandItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              materialId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              salesOrderItemId: z.string().uuid().nullable().optional(),
              idx: z.number().int().optional(),
              qty: z.string().min(1).optional(),
              needDate: z.string().nullable().optional(),
              fulfillmentMethod: z.string().optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await demands.updateDemandItem(permitOf(c), c.req.valid('param').id, {
            materialId: body.materialId,
            unitId: body.unitId,
            salesOrderItemId: body.salesOrderItemId,
            salesOrderItemIdPresent: present(raw, 'salesOrderItemId'),
            idx: body.idx,
            qty: body.qty,
            needDate: body.needDate,
            needDatePresent: present(raw, 'needDate'),
            fulfillmentMethod: body.fulfillmentMethod,
            remarks: body.remarks,
            remarksPresent: present(raw, 'remarks'),
          })
          return c.json(demandItemWire(item))
        },
      )
      .delete(
        '/demand-items/:id',
        demandItemGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await demands.deleteDemandItem(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/demand-items/:id/complete',
        demandItemGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            demandItemWire(
              await demands.completeDemandItem(permitOf(c), c.req.valid('param').id),
            ),
          ),
      )
      .get(
        '/demand-items/:id/arrangements',
        demandItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const rows = await demands.listArrangements(permitOf(c), c.req.valid('param').id)
          return c.json({
            count: rows.length,
            results: rows.map((r) => ({
              id: r.id,
              demandItemId: r.demandItemId,
              companyId: r.companyId,
              arrangementType: String(r.arrangementType).toUpperCase(),
              qty: r.qty,
              baseQty: r.baseQty,
              workOrderId: r.workOrderId,
              purchaseOrderItemId: r.purchaseOrderItemId,
              remarks: r.remarks,
              insertedAt: r.insertedAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
            })),
          })
        },
      )
      .post(
        '/demand-items/:id/arrangements',
        demandItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              arrangementType: z.enum(['STOCK', 'CLOSE', 'stock', 'close']),
              qty: z.string().min(1),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const item = await demands.createArrangement(permitOf(c), {
            demandItemId: c.req.valid('param').id,
            arrangementType: body.arrangementType.toLowerCase() as 'stock' | 'close',
            qty: body.qty,
            remarks: body.remarks,
          })
          return c.json(demandItemWire(item), 201)
        },
      )
      .delete(
        '/demand-arrangements/:id',
        demandItemGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await demands.removeArrangement(permitOf(c), c.req.valid('param').id)
          return c.json(demandItemWire(item))
        },
      )
      .post(
        '/demand-items/:id/fulfillment',
        demandItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ fulfillmentMethod: z.string().min(1) }).strict(),
          validationHook,
        ),
        async (c) =>
          c.json(
            demandItemWire(
              await demands.changeFulfillment(
                permitOf(c),
                c.req.valid('param').id,
                c.req.valid('json').fulfillmentMethod,
              ),
            ),
          ),
      )
      .post(
        '/sales-item-occupancies',
        demandGuard('read'),
        zValidator(
          'json',
          z.object({ salesOrderItemIds: z.array(z.string().uuid()) }).strict(),
          validationHook,
        ),
        async (c) => {
          const results = await demands.salesOccupancies(
            permitOf(c),
            c.req.valid('json').salesOrderItemIds,
          )
          return c.json({ results: results.map(occupancyWire) })
        },
      )
      // —— 工单 ——
      .post(
        '/work-orders/query',
        workOrderGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await workOrders.listWorkOrders(
            permitOf(c),
            toList(c.req.valid('json')),
          )
          return c.json(listWire(result, workOrderWire))
        },
      )
      .post(
        '/work-orders',
        // 从需求行建单：来源需求单必须可读（范围取格上最小，车间只能拿下发到本部门的需求单开工）
        workOrderGuard('create', { allOf: [codeOf(DEMAND_RESOURCE, 'read')] }),
        zValidator(
          'json',
          z
            .object({
              demandItemId: z.string().uuid(),
              workOrderNo: z.string().max(32).nullable().optional(),
              qty: z.string().min(1).nullable().optional(),
              bomId: z.string().uuid().nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await workOrders.createWorkOrder(permitOf(c), c.req.valid('json'))
          return c.json(workOrderWire(item), 201)
        },
      )
      .get(
        '/work-orders/:id',
        workOrderGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            workOrderWire(await workOrders.getWorkOrder(permitOf(c), c.req.valid('param').id)),
          ),
      )
      .patch(
        '/work-orders/:id',
        workOrderGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ workOrderNo: z.string().max(32) }).strict(),
          validationHook,
        ),
        async (c) => {
          const item = await workOrders.updateWorkOrder(
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          )
          return c.json(workOrderWire(item))
        },
      )
      .delete(
        '/work-orders/:id',
        workOrderGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await workOrders.deleteWorkOrder(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/work-orders/:id/apply-bom',
        workOrderGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ bomId: z.string().uuid().nullable() }).strict(),
          validationHook,
        ),
        async (c) => {
          const item = await workOrders.applyBom(
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json').bomId,
          )
          return c.json(workOrderWire(item))
        },
      )
      .get(
        '/work-orders/:id/bom-snapshot',
        workOrderGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const snap = await workOrders.getBomSnapshot(
            permitOf(c),
            c.req.valid('param').id,
          )
          return c.json(snap)
        },
      )
      .post(
        '/work-orders/:id/create-bom',
        // 内嵌建 BOM：同时要工单 update 与 BOM create
        workOrderGuard('update', { allOf: [codeOf(BOM_RESOURCE, 'create')] }),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              code: z.string().max(32).nullable().optional(),
              planName: z.string().max(64).nullable().optional(),
              note: z.string().max(255).nullable().optional(),
              components: z
                .array(
                  z
                    .object({
                      materialId: z.string().uuid(),
                      unitId: z.string().uuid(),
                      quantity: z.string().min(1),
                      lossRate: z.string().nullable().optional(),
                      note: z.string().max(512).nullable().optional(),
                    })
                    .strict(),
                )
                .optional(),
              routes: z
                .array(
                  z
                    .object({
                      operationId: z.string().uuid(),
                      seq: z.number().int(),
                      requirement: z.string().max(512).nullable().optional(),
                      isOutsourced: z.boolean().optional(),
                    })
                    .strict(),
                )
                .optional(),
              byproducts: z
                .array(
                  z
                    .object({
                      materialId: z.string().uuid(),
                      unitId: z.string().uuid(),
                      quantity: z.string().min(1),
                      note: z.string().max(512).nullable().optional(),
                    })
                    .strict(),
                )
                .optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const result = await workOrders.createInlineBom(
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          )
          return c.json(
            {
              workOrder: workOrderWire(result.workOrder),
              bom: bomWire(result.bom),
            },
            201,
          )
        },
      )
      .post(
        '/work-orders/:id/void',
        workOrderGuard('void'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          // 作废级联（票 04）：派生草稿已物理删；confirmedDerivedDemandNos 为
          // 已确认派生单警告名单（additive 字段，不拦截，前端展示由人收场）
          const result = await workOrders.voidWorkOrder(permitOf(c), c.req.valid('param').id)
          return c.json({
            ...workOrderWire(result.workOrder),
            confirmedDerivedDemandNos: result.confirmedDerivedDemandNos,
          })
        },
      )
      // 弹窗取数（票 02）：每行毛需求+参考库存快照与默认数量/默认去向标记；
      // 与动作同码（限定入口），只读不写
      .get(
        '/work-orders/:id/material-demand-preview',
        workOrderGuard('read', { allOf: [codeOf(DEMAND_RESOURCE, 'create')] }),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            await workOrders.getMaterialDemandPreview(permitOf(c), c.req.valid('param').id),
          ),
      )
      // 生成物料需求：不再是工单动作。用户以 mfg.demand:create 建需求；
      // 工单只要求可读（装载来源），需求单头/行由服务内受信任写落库。
      .post(
        '/work-orders/:id/generate-material-demand',
        workOrderGuard('read', { allOf: [codeOf(DEMAND_RESOURCE, 'create')] }),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              lines: z
                .array(
                  z
                    .object({
                      componentId: z.string().uuid(),
                      qty: z.string().min(1),
                      target: z.discriminatedUnion('kind', [
                        z
                          .object({ kind: z.literal('dept'), deptId: z.string().uuid() })
                          .strict(),
                        z.object({ kind: z.literal('purchase') }).strict(),
                      ]),
                    })
                    .strict(),
                )
                .min(1),
              // 重复生成（票 04）：已有未删除派生草稿时响应先回警告标记，
              // 前端二次确认后带 force 重发才正常生成
              force: z.boolean().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const result = await workOrders.generateMaterialDemand(
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          )
          return c.json(result, 201)
        },
      )
      // —— 生产入库 ——
      .post(
        '/outputs/query',
        outputGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await outputs.listOutputs(permitOf(c), toList(c.req.valid('json')))
          return c.json(listWire(result, outputWire))
        },
      )
      .post(
        '/outputs',
        outputGuard('create'),
        zValidator(
          'json',
          z
            .object({
              companyId: z.string().uuid(),
              outputNo: z.string().max(32).nullable().optional(),
              outputDate: z.string().optional(),
              warehouseId: z.string().uuid().nullable().optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await outputs.createOutput(permitOf(c), c.req.valid('json'))
          return c.json(outputWire(item), 201)
        },
      )
      .get(
        '/outputs/:id',
        outputGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(outputWire(await outputs.getOutput(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/outputs/:id',
        outputGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              outputNo: z.string().max(32).optional(),
              outputDate: z.string().optional(),
              warehouseId: z.string().uuid().nullable().optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await outputs.updateOutput(permitOf(c), c.req.valid('param').id, {
            outputNo: body.outputNo,
            outputDate: body.outputDate,
            warehouseId: body.warehouseId,
            warehouseIdPresent: present(raw, 'warehouseId'),
            remarks: body.remarks,
            remarksPresent: present(raw, 'remarks'),
          })
          return c.json(outputWire(item))
        },
      )
      .delete(
        '/outputs/:id',
        outputGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await outputs.deleteOutput(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/outputs/:id/audit',
        outputGuard('audit'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(outputWire(await outputs.auditOutput(permitOf(c), c.req.valid('param').id))),
      )
      .post(
        '/outputs/:id/void',
        outputGuard('void'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(outputWire(await outputs.voidOutput(permitOf(c), c.req.valid('param').id))),
      )
      // —— 入库行 ——
      .post(
        '/output-items/query',
        outputItemGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const outputId =
            typeof filter?.outputId === 'object' && filter.outputId && 'value' in filter.outputId
              ? String(filter.outputId.value)
              : undefined
          const result = await outputs.listOutputItems(permitOf(c), {
            ...toList(body),
            outputId,
          })
          return c.json(listWire(result, outputItemWire))
        },
      )
      .post(
        '/output-items',
        // 入库行引用生产工单：只能拿自己看得见的工单入库
        outputItemGuard('create', { allOf: [codeOf(WORK_ORDER_RESOURCE, 'read')] }),
        zValidator(
          'json',
          z
            .object({
              outputId: z.string().uuid(),
              workOrderId: z.string().uuid(),
              unitId: z.string().uuid(),
              warehouseId: z.string().uuid(),
              idx: z.number().int(),
              qty: z.string().min(1),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await outputs.createOutputItem(permitOf(c), c.req.valid('json'))
          return c.json(outputItemWire(item), 201)
        },
      )
      .get(
        '/output-items/:id',
        outputItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            outputItemWire(await outputs.getOutputItem(permitOf(c), c.req.valid('param').id)),
          ),
      )
      .patch(
        '/output-items/:id',
        outputItemGuard('update', { allOf: [codeOf(WORK_ORDER_RESOURCE, 'read')] }),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              workOrderId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              warehouseId: z.string().uuid().optional(),
              idx: z.number().int().optional(),
              qty: z.string().min(1).optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await outputs.updateOutputItem(permitOf(c), c.req.valid('param').id, {
            workOrderId: body.workOrderId,
            unitId: body.unitId,
            warehouseId: body.warehouseId,
            idx: body.idx,
            qty: body.qty,
            remarks: body.remarks,
            remarksPresent: present(raw, 'remarks'),
          })
          return c.json(outputItemWire(item))
        },
      )
      .delete(
        '/output-items/:id',
        outputItemGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await outputs.deleteOutputItem(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
  )
}
