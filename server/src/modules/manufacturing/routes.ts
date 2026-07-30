import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { DemandService } from './demand-service.ts'
import type { MasterService } from './master-service.ts'
import type { OutputService } from './output-service.ts'
import type { WorkOrderService } from './work-order-service.ts'
import {
  bomByproductWire,
  bomComponentWire,
  bomRouteWire,
  bomWire,
  demandItemWire,
  demandWire,
  listWire,
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
  master: MasterService
  demands: DemandService
  workOrders: WorkOrderService
  outputs: OutputService
}

/** 挂载于 /manufacturing */
export function manufacturingRoutes(deps: ManufacturingRouteDeps) {
  const { auth, master, demands, workOrders, outputs } = deps

  return (
    new Hono<AppEnv>()
      .use('*', requireAuth(auth))
      // —— 工序 ——
      .post(
        '/operations/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await master.listOperations(c.get('actor'), toList(c.req.valid('json')))
          return c.json(listWire(result, operationWire))
        },
      )
      .post(
        '/operations',
        zValidator('json', headCreate, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const item = await master.createOperation(c.get('actor'), body)
          return c.json(operationWire(item), 201)
        },
      )
      .get(
        '/operations/:id',
        zValidator('param', idParam, validationHook),
        async (c) => c.json(operationWire(await master.getOperation(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/operations/:id',
        zValidator('param', idParam, validationHook),
        zValidator('json', headUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateOperation(c.get('actor'), c.req.valid('param').id, {
            name: body.name,
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(operationWire(item))
        },
      )
      .delete(
        '/operations/:id',
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteOperation(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 工艺模板 ——
      .post(
        '/process-templates/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await master.listTemplates(c.get('actor'), toList(c.req.valid('json')))
          return c.json(listWire(result, templateWire))
        },
      )
      .post(
        '/process-templates',
        zValidator('json', headCreate, validationHook),
        async (c) => {
          const item = await master.createTemplate(c.get('actor'), c.req.valid('json'))
          return c.json(templateWire(item), 201)
        },
      )
      .get(
        '/process-templates/:id',
        zValidator('param', idParam, validationHook),
        async (c) => c.json(templateWire(await master.getTemplate(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/process-templates/:id',
        zValidator('param', idParam, validationHook),
        zValidator('json', headUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateTemplate(c.get('actor'), c.req.valid('param').id, {
            name: body.name,
            note: body.note,
            notePresent: present(raw, 'note'),
          })
          return c.json(templateWire(item))
        },
      )
      .delete(
        '/process-templates/:id',
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteTemplate(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 工艺模板行 ——
      .post(
        '/process-template-items/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const templateId =
            typeof filter?.templateId === 'object' && filter.templateId && 'value' in filter.templateId
              ? String(filter.templateId.value)
              : undefined
          const result = await master.listTemplateItems(c.get('actor'), { ...toList(body), templateId })
          return c.json(listWire(result, templateItemWire))
        },
      )
      .post(
        '/process-template-items',
        zValidator(
          'json',
          routeItemCreate.extend({ templateId: z.string().uuid() }).strict(),
          validationHook,
        ),
        async (c) => {
          const body = c.req.valid('json')
          const item = await master.createTemplateItem(c.get('actor'), {
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
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(templateItemWire(await master.getTemplateItem(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/process-template-items/:id',
        zValidator('param', idParam, validationHook),
        zValidator('json', routeItemUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateTemplateItem(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteTemplateItem(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— BOM ——
      .post(
        '/boms/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await master.listBoms(c.get('actor'), toList(c.req.valid('json')))
          return c.json(listWire(result, bomWire))
        },
      )
      .post(
        '/boms',
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
          const item = await master.createBom(c.get('actor'), {
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
        zValidator('param', idParam, validationHook),
        async (c) => c.json(bomWire(await master.getBom(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/boms/:id',
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
          const item = await master.updateBom(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteBom(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/boms/:id/activate',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await master.activateBom(c.get('actor'), c.req.valid('param').id)
          return c.json(bomWire(item))
        },
      )
      .post(
        '/boms/:id/deactivate',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await master.deactivateBom(c.get('actor'), c.req.valid('param').id)
          return c.json(bomWire(item))
        },
      )
      .post(
        '/boms/:id/apply-route-template',
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ templateId: z.string().uuid() }).strict(),
          validationHook,
        ),
        async (c) => {
          const routes = await master.applyRouteTemplate(
            c.get('actor'),
            c.req.valid('param').id,
            c.req.valid('json').templateId,
          )
          return c.json({ count: routes.length, results: routes.map(bomRouteWire) })
        },
      )
      // —— BOM 配料 ——
      .post(
        '/bom-components/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const bomId =
            typeof filter?.bomId === 'object' && filter.bomId && 'value' in filter.bomId
              ? String(filter.bomId.value)
              : undefined
          const result = await master.listComponents(c.get('actor'), { ...toList(body), bomId })
          return c.json(listWire(result, bomComponentWire))
        },
      )
      .post(
        '/bom-components',
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
          const item = await master.createComponent(c.get('actor'), c.req.valid('json'))
          return c.json(bomComponentWire(item), 201)
        },
      )
      .get(
        '/bom-components/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(bomComponentWire(await master.getComponent(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/bom-components/:id',
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
          const item = await master.updateComponent(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteComponent(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— BOM 路线 ——
      .post(
        '/bom-routes/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const bomId =
            typeof filter?.bomId === 'object' && filter.bomId && 'value' in filter.bomId
              ? String(filter.bomId.value)
              : undefined
          const result = await master.listRoutes(c.get('actor'), { ...toList(body), bomId })
          return c.json(listWire(result, bomRouteWire))
        },
      )
      .post(
        '/bom-routes',
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
          const item = await master.createRoute(c.get('actor'), c.req.valid('json'))
          return c.json(bomRouteWire(item), 201)
        },
      )
      .get(
        '/bom-routes/:id',
        zValidator('param', idParam, validationHook),
        async (c) => c.json(bomRouteWire(await master.getRoute(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/bom-routes/:id',
        zValidator('param', idParam, validationHook),
        zValidator('json', routeItemUpdate, validationHook),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await master.updateRoute(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteRoute(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— BOM 副产品 ——
      .post(
        '/bom-byproducts/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const bomId =
            typeof filter?.bomId === 'object' && filter.bomId && 'value' in filter.bomId
              ? String(filter.bomId.value)
              : undefined
          const result = await master.listByproducts(c.get('actor'), { ...toList(body), bomId })
          return c.json(listWire(result, bomByproductWire))
        },
      )
      .post(
        '/bom-byproducts',
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
          const item = await master.createByproduct(c.get('actor'), c.req.valid('json'))
          return c.json(bomByproductWire(item), 201)
        },
      )
      .get(
        '/bom-byproducts/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(bomByproductWire(await master.getByproduct(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/bom-byproducts/:id',
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
          const item = await master.updateByproduct(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await master.deleteByproduct(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      // —— 履约需求 ——
      .post(
        '/demands/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await demands.listDemands(c.get('actor'), toList(c.req.valid('json')))
          return c.json(listWire(result, demandWire))
        },
      )
      .post(
        '/demands',
        zValidator(
          'json',
          z
            .object({
              companyId: z.string().uuid(),
              demandNo: z.string().max(32).nullable().optional(),
              demandDate: z.string().optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await demands.createDemand(c.get('actor'), c.req.valid('json'))
          return c.json(demandWire(item), 201)
        },
      )
      .get(
        '/demands/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.getDemand(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/demands/:id',
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z
            .object({
              demandNo: z.string().max(32).optional(),
              demandDate: z.string().optional(),
              remarks: z.string().max(512).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const raw = (await c.req.json()) as Record<string, unknown>
          const body = c.req.valid('json')
          const item = await demands.updateDemand(c.get('actor'), c.req.valid('param').id, {
            demandNo: body.demandNo,
            demandDate: body.demandDate,
            remarks: body.remarks,
            remarksPresent: present(raw, 'remarks'),
          })
          return c.json(demandWire(item))
        },
      )
      .delete(
        '/demands/:id',
        zValidator('param', idParam, validationHook),
        async (c) => {
          await demands.deleteDemand(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/demands/:id/confirm',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.confirmDemand(c.get('actor'), c.req.valid('param').id))),
      )
      .post(
        '/demands/:id/close',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.closeDemand(c.get('actor'), c.req.valid('param').id))),
      )
      .post(
        '/demands/:id/void',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(demandWire(await demands.voidDemand(c.get('actor'), c.req.valid('param').id))),
      )
      // —— 需求行 ——
      .post(
        '/demand-items/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const demandId =
            typeof filter?.demandId === 'object' && filter.demandId && 'value' in filter.demandId
              ? String(filter.demandId.value)
              : undefined
          const result = await demands.listDemandItems(c.get('actor'), {
            ...toList(body),
            demandId,
          })
          return c.json(listWire(result, demandItemWire))
        },
      )
      .post(
        '/demand-items',
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
          const item = await demands.createDemandItem(c.get('actor'), c.req.valid('json'))
          return c.json(demandItemWire(item), 201)
        },
      )
      .get(
        '/demand-items/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            demandItemWire(await demands.getDemandItem(c.get('actor'), c.req.valid('param').id)),
          ),
      )
      .patch(
        '/demand-items/:id',
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
          const item = await demands.updateDemandItem(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await demands.deleteDemandItem(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/demand-items/:id/complete',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            demandItemWire(
              await demands.completeDemandItem(c.get('actor'), c.req.valid('param').id),
            ),
          ),
      )
      .get(
        '/demand-items/:id/arrangements',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const rows = await demands.listArrangements(c.get('actor'), c.req.valid('param').id)
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
          const item = await demands.createArrangement(c.get('actor'), {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          const item = await demands.removeArrangement(c.get('actor'), c.req.valid('param').id)
          return c.json(demandItemWire(item))
        },
      )
      .post(
        '/demand-items/:id/fulfillment',
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
                c.get('actor'),
                c.req.valid('param').id,
                c.req.valid('json').fulfillmentMethod,
              ),
            ),
          ),
      )
      .post(
        '/sales-item-occupancies',
        zValidator(
          'json',
          z.object({ salesOrderItemIds: z.array(z.string().uuid()) }).strict(),
          validationHook,
        ),
        async (c) => {
          const results = await demands.salesOccupancies(
            c.get('actor'),
            c.req.valid('json').salesOrderItemIds,
          )
          return c.json({ results: results.map(occupancyWire) })
        },
      )
      // —— 工单 ——
      .post(
        '/work-orders/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await workOrders.listWorkOrders(
            c.get('actor'),
            toList(c.req.valid('json')),
          )
          return c.json(listWire(result, workOrderWire))
        },
      )
      .post(
        '/work-orders',
        zValidator(
          'json',
          z
            .object({
              demandItemId: z.string().uuid(),
              workOrderNo: z.string().max(32).nullable().optional(),
              qty: z.string().min(1).nullable().optional(),
            })
            .strict(),
          validationHook,
        ),
        async (c) => {
          const item = await workOrders.createWorkOrder(c.get('actor'), c.req.valid('json'))
          return c.json(workOrderWire(item), 201)
        },
      )
      .get(
        '/work-orders/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            workOrderWire(await workOrders.getWorkOrder(c.get('actor'), c.req.valid('param').id)),
          ),
      )
      .patch(
        '/work-orders/:id',
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ workOrderNo: z.string().max(32) }).strict(),
          validationHook,
        ),
        async (c) => {
          const item = await workOrders.updateWorkOrder(
            c.get('actor'),
            c.req.valid('param').id,
            c.req.valid('json'),
          )
          return c.json(workOrderWire(item))
        },
      )
      .delete(
        '/work-orders/:id',
        zValidator('param', idParam, validationHook),
        async (c) => {
          await workOrders.deleteWorkOrder(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/work-orders/:id/apply-bom',
        zValidator('param', idParam, validationHook),
        zValidator(
          'json',
          z.object({ bomId: z.string().uuid().nullable() }).strict(),
          validationHook,
        ),
        async (c) => {
          const item = await workOrders.applyBom(
            c.get('actor'),
            c.req.valid('param').id,
            c.req.valid('json').bomId,
          )
          return c.json(workOrderWire(item))
        },
      )
      .get(
        '/work-orders/:id/bom-snapshot',
        zValidator('param', idParam, validationHook),
        async (c) => {
          const snap = await workOrders.getBomSnapshot(
            c.get('actor'),
            c.req.valid('param').id,
          )
          return c.json(snap)
        },
      )
      .post(
        '/work-orders/:id/create-bom',
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
            c.get('actor'),
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
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            workOrderWire(await workOrders.voidWorkOrder(c.get('actor'), c.req.valid('param').id)),
          ),
      )
      // —— 生产入库 ——
      .post(
        '/outputs/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const result = await outputs.listOutputs(c.get('actor'), toList(c.req.valid('json')))
          return c.json(listWire(result, outputWire))
        },
      )
      .post(
        '/outputs',
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
          const item = await outputs.createOutput(c.get('actor'), c.req.valid('json'))
          return c.json(outputWire(item), 201)
        },
      )
      .get(
        '/outputs/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(outputWire(await outputs.getOutput(c.get('actor'), c.req.valid('param').id))),
      )
      .patch(
        '/outputs/:id',
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
          const item = await outputs.updateOutput(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await outputs.deleteOutput(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
      .post(
        '/outputs/:id/audit',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(outputWire(await outputs.auditOutput(c.get('actor'), c.req.valid('param').id))),
      )
      .post(
        '/outputs/:id/void',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(outputWire(await outputs.voidOutput(c.get('actor'), c.req.valid('param').id))),
      )
      // —— 入库行 ——
      .post(
        '/output-items/query',
        zValidator('json', listQuerySchema, validationHook),
        async (c) => {
          const body = c.req.valid('json')
          const filter = body.filter as Record<string, { value?: string }> | undefined
          const outputId =
            typeof filter?.outputId === 'object' && filter.outputId && 'value' in filter.outputId
              ? String(filter.outputId.value)
              : undefined
          const result = await outputs.listOutputItems(c.get('actor'), {
            ...toList(body),
            outputId,
          })
          return c.json(listWire(result, outputItemWire))
        },
      )
      .post(
        '/output-items',
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
          const item = await outputs.createOutputItem(c.get('actor'), c.req.valid('json'))
          return c.json(outputItemWire(item), 201)
        },
      )
      .get(
        '/output-items/:id',
        zValidator('param', idParam, validationHook),
        async (c) =>
          c.json(
            outputItemWire(await outputs.getOutputItem(c.get('actor'), c.req.valid('param').id)),
          ),
      )
      .patch(
        '/output-items/:id',
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
          const item = await outputs.updateOutputItem(c.get('actor'), c.req.valid('param').id, {
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
        zValidator('param', idParam, validationHook),
        async (c) => {
          await outputs.deleteOutputItem(c.get('actor'), c.req.valid('param').id)
          return c.body(null, 204)
        },
      )
  )
}
