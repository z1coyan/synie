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
  bomByproductWire,
  bomComponentWire,
  bomRouteWire,
  bomWire,
  demandItemWire,
  demandWire,
  listWire,
  moldDesignWire,
  occupancyWire,
  operationWire,
  outputItemWire,
  outputWire,
  templateItemWire,
  templateWire,
  workOrderWire,
} from './wire.ts'

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

const idParam = z.object({ id: z.string().uuid() })

const headCreate = z
  .object({
    code: z.string().max(32).nullable().optional(),
    name: z.string().min(1).max(64),
    note: z.string().max(255).nullable().optional(),
  })
  .strict()

const headUpdate = z
  .object({
    name: z.string().min(1).max(64).optional(),
    note: z.string().max(255).nullable().optional(),
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

const routeItemCreate = z
  .object({
    templateId: z.string().uuid().optional(),
    bomId: z.string().uuid().optional(),
    operationId: z.string().uuid(),
    seq: z.number().int(),
    requirement: z.string().max(512).nullable().optional(),
    isOutsourced: z.boolean().optional(),
  })
  .strict()

const routeItemUpdate = z
  .object({
    operationId: z.string().uuid().optional(),
    seq: z.number().int().optional(),
    requirement: z.string().max(512).nullable().optional(),
    isOutsourced: z.boolean().optional(),
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
  master: MasterService
  demands: DemandService
  workOrders: WorkOrderService
  outputs: OutputService
  moldDesigns: MoldDesignService
}

/**
 * 挂载于 /manufacturing。
 *
 * 全部端点逐个挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 跨资源门控用 guard 的 allOf（附加码从 `authz.targetOf(资源).prefix` 拼，不写字面量）：
 * 从需求行建工单要 `mfg.demand:read`、入库行引用工单要 `mfg.work_order:read`、
 * 工单内嵌建 BOM 要 `mfg.bom:create`、模具设计连带写物料要 `base.material:*`、
 * BOM 套用工艺模板要 `mfg.route_template:read`——范围取格上最小，来源单据行级可达性一并成立。
 * 子行 create「持 create 或 update 均可」用 guard 的 anyOf（旧 requireCreateOrUpdate 已删）。
 */
export function manufacturingRoutes(deps: ManufacturingRouteDeps) {
  const { auth, authz, master, demands, workOrders, outputs, moldDesigns } = deps
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
  const operationGuard = (action: string) => authz.guard(OPERATION_RESOURCE, action)
  const templateGuard = (action: string) => authz.guard(TEMPLATE_RESOURCE, action)
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
  const childWriteAnyOf = (resource: string) => [
    codeOf(resource, 'update'),
    codeOf(resource, 'create'),
  ]
  const childGuard = (resource: string) => (action: string, anyOf?: readonly string[]) =>
    authz.guard(resource, action, anyOf ? { anyOf } : undefined)
  const templateItemGuard = childGuard(TEMPLATE_ITEM_RESOURCE)
  const componentGuard = childGuard(BOM_COMPONENT_RESOURCE)
  const bomRouteGuard = childGuard(BOM_ROUTE_RESOURCE)
  const byproductGuard = childGuard(BOM_BYPRODUCT_RESOURCE)

  return (
    new Hono<AppEnv>()
      .use('*', requireAuth(auth))
      // —— 工序 ——
      .post(
        '/operations/query',
        operationGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await master.listOperations(permitOf(c), toList(c.req.valid('json')))
          return c.json(listWire(result, operationWire))
        },
      )
      .post(
        '/operations',
        operationGuard('create'),
        zValidator('json', headCreate, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const item = await master.createOperation(permitOf(c), body)
          return c.json(operationWire(item), 201)
        },
      )
      .get(
        '/operations/:id',
        operationGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => c.json(operationWire(await master.getOperation(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/operations/:id',
        operationGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator('json', headUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateOperation(permitOf(c), c.req.valid('param').id, {
            name: body.name,
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(operationWire(item))
        },
      )
      .delete(
        '/operations/:id',
        operationGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteOperation(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 模具设计 ——
      .post(
        '/mold-designs/query',
        moldGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await moldDesigns.list(permitOf(c), toList(c.req.valid('json')))
          return c.json(listWire(result, moldDesignWire))
        },
      )
      .post(
        '/mold-designs',
        moldGuard('create', 'create'),
        zValidator('json', moldDesignCreate, validationHook),
        async (c) => {
          const item = await moldDesigns.create(permitOf(c), c.req.valid('json'))
          return c.json(moldDesignWire(item), 201)
        },
      )
      .get(
        '/mold-designs/:id',
        moldGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(moldDesignWire(await moldDesigns.get(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/mold-designs/:id',
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
      .delete(
        '/mold-designs/:id',
        moldGuard('delete', 'delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await moldDesigns.remove(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 工艺模板 ——
      .post(
        '/process-templates/query',
        templateGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await master.listTemplates(permitOf(c), toList(c.req.valid('json')))
          return c.json(listWire(result, templateWire))
        },
      )
      .post(
        '/process-templates',
        templateGuard('create'),
        zValidator('json', headCreate, validationHook),
        async (c) => {
          const item = await master.createTemplate(permitOf(c), c.req.valid('json'))
          return c.json(templateWire(item), 201)
        },
      )
      .get(
        '/process-templates/:id',
        templateGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => c.json(templateWire(await master.getTemplate(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/process-templates/:id',
        templateGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator('json', headUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateTemplate(permitOf(c), c.req.valid('param').id, {
            name: body.name,
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(templateWire(item))
        },
      )
      .delete(
        '/process-templates/:id',
        templateGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteTemplate(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 工艺模板行 ——
      .post(
        '/process-template-items/query',
        templateItemGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const templateId =
            typeof filter?.templateId === 'object' && filter.templateId && 'value' in filter.templateId
              ? String(filter.templateId.value)
              : undefined
          const result = await master.listTemplateItems(permitOf(c), { ...toList(body), templateId })
          return c.json(listWire(result, templateItemWire))
        },
      )
      .post(
        '/process-template-items',
        templateItemGuard('update', childWriteAnyOf(TEMPLATE_ITEM_RESOURCE)),
        zValidator(
          'json',
          routeItemCreate.extend({ templateId: z.string().uuid() }).strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const item = await master.createTemplateItem(permitOf(c), {
            templateId: body.templateId,
            operationId: body.operationId,
            seq: body.seq,
            requirement: body.requirement,
            isOutsourced: body.isOutsourced,
          })
          return c.json(templateItemWire(item), 201)
        },
      )
      .get(
        '/process-template-items/:id',
        templateItemGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(templateItemWire(await master.getTemplateItem(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/process-template-items/:id',
        templateItemGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator('json', routeItemUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateTemplateItem(permitOf(c), c.req.valid('param').id, {
            operationId: body.operationId,
            seq: body.seq,
            requirement: body.requirement,
            requirementPresent: present(raw, 'requirement'),
            isOutsourced: body.isOutsourced,
          })
          return c.json(templateItemWire(item))
        },
      )
      .delete(
        '/process-template-items/:id',
        templateItemGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteTemplateItem(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— BOM ——
      .post(
        '/boms/query',
        bomGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await master.listBoms(permitOf(c), toList(c.req.valid('json')))
          return c.json(listWire(result, bomWire))
        },
      )
      .post(
        '/boms',
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
      .get(
        '/boms/:id',
        bomGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => c.json(bomWire(await master.getBom(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/boms/:id',
        bomGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              planName: z.string().max(64).nullable().optional(),
              note: z.string().max(255).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateBom(permitOf(c), c.req.valid('param').id, {
            planName: body.planName,
            planNamePresent: present(raw, 'planName'),
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(bomWire(item))
        },
      )
      .delete(
        '/boms/:id',
        bomGuard('delete'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteBom(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/boms/:id/activate',
        bomGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await master.activateBom(permitOf(c), c.req.valid('param').id)
          return c.json(bomWire(item))
        },
      )
      .post(
        '/boms/:id/deactivate',
        bomGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await master.deactivateBom(permitOf(c), c.req.valid('param').id)
          return c.json(bomWire(item))
        },
      )
      .post(
        '/boms/:id/apply-route-template',
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
      // —— BOM 配料 ——
      .post(
        '/bom-components/query',
        componentGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const bomId =
            typeof filter?.bomId === 'object' && filter.bomId && 'value' in filter.bomId
              ? String(filter.bomId.value)
              : undefined
          const result = await master.listComponents(permitOf(c), { ...toList(body), bomId })
          return c.json(listWire(result, bomComponentWire))
        },
      )
      .post(
        '/bom-components',
        componentGuard('update', childWriteAnyOf(BOM_COMPONENT_RESOURCE)),
        zValidator(
          'json',
          z
            .object({
              bomId: z.string().uuid(),
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              quantity: z.string().min(1),
              lossRate: z.string().nullable().optional(),
              note: z.string().max(255).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await master.createComponent(permitOf(c), c.req.valid('json'))
          return c.json(bomComponentWire(item), 201)
        },
      )
      .get(
        '/bom-components/:id',
        componentGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(bomComponentWire(await master.getComponent(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/bom-components/:id',
        componentGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              materialId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              quantity: z.string().min(1).optional(),
              lossRate: z.string().nullable().optional(),
              note: z.string().max(255).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateComponent(permitOf(c), c.req.valid('param').id, {
            materialId: body.materialId,
            unitId: body.unitId,
            quantity: body.quantity,
            lossRate: body.lossRate,
            lossRatePresent: present(raw, 'lossRate'),
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(bomComponentWire(item))
        },
      )
      .delete(
        '/bom-components/:id',
        componentGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteComponent(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— BOM 路线 ——
      .post(
        '/bom-routes/query',
        bomRouteGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const bomId =
            typeof filter?.bomId === 'object' && filter.bomId && 'value' in filter.bomId
              ? String(filter.bomId.value)
              : undefined
          const result = await master.listRoutes(permitOf(c), { ...toList(body), bomId })
          return c.json(listWire(result, bomRouteWire))
        },
      )
      .post(
        '/bom-routes',
        bomRouteGuard('update', childWriteAnyOf(BOM_ROUTE_RESOURCE)),
        zValidator(
          'json',
          z
            .object({
              bomId: z.string().uuid(),
              operationId: z.string().uuid(),
              seq: z.number().int(),
              requirement: z.string().max(512).nullable().optional(),
              isOutsourced: z.boolean().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await master.createRoute(permitOf(c), c.req.valid('json'))
          return c.json(bomRouteWire(item), 201)
        },
      )
      .get(
        '/bom-routes/:id',
        bomRouteGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) => c.json(bomRouteWire(await master.getRoute(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/bom-routes/:id',
        bomRouteGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator('json', routeItemUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateRoute(permitOf(c), c.req.valid('param').id, {
            operationId: body.operationId,
            seq: body.seq,
            requirement: body.requirement,
            requirementPresent: present(raw, 'requirement'),
            isOutsourced: body.isOutsourced,
          })
          return c.json(bomRouteWire(item))
        },
      )
      .delete(
        '/bom-routes/:id',
        bomRouteGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteRoute(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— BOM 副产品 ——
      .post(
        '/bom-byproducts/query',
        byproductGuard('read'),
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const bomId =
            typeof filter?.bomId === 'object' && filter.bomId && 'value' in filter.bomId
              ? String(filter.bomId.value)
              : undefined
          const result = await master.listByproducts(permitOf(c), { ...toList(body), bomId })
          return c.json(listWire(result, bomByproductWire))
        },
      )
      .post(
        '/bom-byproducts',
        byproductGuard('update', childWriteAnyOf(BOM_BYPRODUCT_RESOURCE)),
        zValidator(
          'json',
          z
            .object({
              bomId: z.string().uuid(),
              materialId: z.string().uuid(),
              unitId: z.string().uuid(),
              quantity: z.string().min(1),
              note: z.string().max(255).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await master.createByproduct(permitOf(c), c.req.valid('json'))
          return c.json(bomByproductWire(item), 201)
        },
      )
      .get(
        '/bom-byproducts/:id',
        byproductGuard('read'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(bomByproductWire(await master.getByproduct(permitOf(c), c.req.valid('param').id))),
      )
      .patch(
        '/bom-byproducts/:id',
        byproductGuard('update'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              materialId: z.string().uuid().optional(),
              unitId: z.string().uuid().optional(),
              quantity: z.string().min(1).optional(),
              note: z.string().max(255).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateByproduct(permitOf(c), c.req.valid('param').id, {
            materialId: body.materialId,
            unitId: body.unitId,
            quantity: body.quantity,
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(bomByproductWire(item))
        },
      )
      .delete(
        '/bom-byproducts/:id',
        byproductGuard('update'),
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteByproduct(permitOf(c), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 履约需求 ——
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
        demandGuard('confirm'),
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.confirmDemand(permitOf(c), c.req.valid('param').id))),
      )
      .post(
        '/demands/:id/close',
        demandGuard('close'),
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
      // 下发/改派车间：已确认未关闭才可用（状态守卫在服务层抛 conflict）
      .post(
        '/demands/:id/dispatch',
        demandGuard('dispatch'),
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ assignedDeptId: z.string().uuid() }).strict(),
          validationHook,
        ),
        async (c) =>
          c.json(
            demandWire(
              await demands.dispatchDemand(
                permitOf(c),
                c.req.valid('param').id,
                c.req.valid('json').assignedDeptId,
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
              needDate: z.string().nullable().optional(),
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
        async (c) =>
          c.json(
            workOrderWire(await workOrders.voidWorkOrder(permitOf(c), c.req.valid('param').id)),
          ),
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
