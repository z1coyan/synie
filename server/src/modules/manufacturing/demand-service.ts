/**
 * 履约需求单：头/行生命周期、销售占用、安排与下发车间。
 *
 * W5 聚合迁移：头 createStandardService + 条目 createStandardChildService +
 * createAggregateService；confirm/close/void → workflow（D7）。
 * 确认占量校验与作废下游拦截进 transition effect；dispatch 非状态转移仍手写。
 * 领域纯函数 / 派生受信任写见 demand-domain.ts。
 *
 * 授权全由平台承担：服务只收 Permit。wire 形枚举大写（库内小写），对齐 mfgOutputs。
 */
import { decimal, toDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { utcToday } from '~/db/dates.ts'
import { syncDrawingAttachments } from '~/modules/trading/common.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createAggregateService, type AggregateService } from '~/platform/standard/aggregate.ts'
import {
  createStandardChildService,
  type StandardChildService,
} from '~/platform/standard/child.ts'
import {
  createStandardService,
  type StandardService,
} from '~/platform/standard/service.ts'
import {
  DEMAND_ITEM_RESOURCE,
  DEMAND_ITEM_TABLE,
  DEMAND_RESOURCE,
  assertAssignLink,
  createDemandSideActions,
  effectConfirmOccupy,
  effectVoidDownstream,
  mapItemExtras,
  parseAssignType,
  presentHead,
  presentItem,
  resolveAssignedDept,
} from './demand-domain.ts'
import {
  deriveItemProjection,
  normalizeList,
  toDateOnly,
  validateNo,
  validateRemarks,
  validateSalesSource,
} from './helpers.ts'
import type { Demand, DemandAssignType, DemandItem, ListQueryInput } from './types.ts'

export {
  DEMAND_ITEM_RESOURCE,
  DEMAND_RESOURCE,
  assertAssignLink,
  cascadeDeleteDerivedDrafts,
  insertDerivedDemand,
  loadDemandAuthorized,
  loadDemandItemAuthorized,
  mapDemandItemRecord,
  mapDemandRecord,
  parseAssignType,
  resolveAssignedDept,
  type DerivedDemandLine,
} from './demand-domain.ts'

const ITEM_DERIVED = [
  'baseQty',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  'status',
  'orderedQty',
  'receivedQty',
  'arrangedQty',
  'completedQty',
  'fulfillmentMethod',
] as const

const ITEM_SOURCE = sql` FROM (
  SELECT i.*,
    (i.arranged_qty > 0 AND i.status <> 'completed') AS ordered,
    greatest(i.base_qty - i.arranged_qty, 0) AS remaining_orderable_qty,
    greatest(i.base_qty - i.arranged_qty, 0) AS remaining_arrangeable_qty
  FROM mfg_demand_item i
) AS mfg_demand_item`

export function createDemandService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const demandTarget = registry.authzTarget(DEMAND_RESOURCE)
  const itemTarget = registry.authzTarget(DEMAND_ITEM_RESOURCE)

  const heads = createStandardService<Demand>({
    db,
    registry,
    resource: DEMAND_RESOURCE,
    notFound: '履约需求单不存在',
    defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
    writeErrors: [
      { code: '23505', constraint: 'mfg_demand_unique_demand_no', message: '需求单号已存在' },
      { code: '23505', message: '制造数据已存在' },
      { code: '23503', message: '制造数据已被业务引用,不可删除' },
    ],
    numbering: { service: numbering, field: 'demandNo' },
    extraWhere: ({ query }) => {
      const companyId = typeof query.companyId === 'string' ? query.companyId : null
      return { where: companyId ? sql`company_id = ${companyId}` : null }
    },
    hooks: {
      insertColumns: ({ permit }) => ({
        status: 'draft',
        created_by_id: permit.actor.userId || null,
      }),
      validate: ({ action, draft, before }) => {
        if (action === 'create') {
          if (!draft.companyId) {
            throw ApiError.validation('履约需求单参数不合法', { companyId: ['必填'] })
          }
          draft.assignType = parseAssignType(
            draft.assignType == null ? null : String(draft.assignType),
          )
        } else if (draft.assignType !== undefined) {
          draft.assignType = parseAssignType(
            draft.assignType == null ? null : String(draft.assignType),
          )
        }
        if (
          action === 'update' &&
          before &&
          draft.demandNo !== undefined &&
          String(draft.demandNo).trim() !== String(before.demandNo)
        ) {
          throw ApiError.validation('履约需求单参数不合法', {
            demandNo: ['编号创建后不可修改'],
          })
        }
        if (typeof draft.demandNo === 'string' && draft.demandNo.trim() !== '') {
          validateNo(String(draft.demandNo), 'demandNo')
        }
        if (draft.remarks !== undefined) validateRemarks(draft.remarks as string | null | undefined)
        else if (action === 'create') validateRemarks(null)
      },
      beforeWrite: async (trx, { action, draft, before }) => {
        if (action === 'create') {
          const blankDate =
            draft.demandDate === undefined ||
            draft.demandDate === null ||
            String(draft.demandDate).trim() === ''
          draft.demandDate = blankDate ? utcToday() : toDateOnly(String(draft.demandDate))
          draft.needDate =
            draft.needDate != null && String(draft.needDate).trim() !== ''
              ? toDateOnly(String(draft.needDate))
              : null
          draft.assignedDeptId = await resolveAssignedDept(
            trx,
            String(draft.companyId),
            draft.assignedDeptId == null || draft.assignedDeptId === ''
              ? null
              : String(draft.assignedDeptId),
          )
          assertAssignLink(
            draft.assignType as DemandAssignType,
            draft.assignedDeptId as string | null,
          )
          draft.remarks = draft.remarks == null ? null : String(draft.remarks)
          return
        }
        if (draft.demandDate != null && String(draft.demandDate).trim() !== '') {
          draft.demandDate = toDateOnly(String(draft.demandDate))
        }
        if (draft.needDate !== undefined) {
          draft.needDate =
            draft.needDate == null || String(draft.needDate).trim() === ''
              ? null
              : toDateOnly(String(draft.needDate))
        }
        if (draft.assignedDeptId !== undefined) {
          draft.assignedDeptId = await resolveAssignedDept(
            trx,
            String(before?.companyId ?? draft.companyId),
            draft.assignedDeptId == null || draft.assignedDeptId === ''
              ? null
              : String(draft.assignedDeptId),
          )
        }
        const assignType = (draft.assignType ?? before?.assignType) as DemandAssignType
        const deptId =
          draft.assignedDeptId !== undefined
            ? (draft.assignedDeptId as string | null)
            : ((before?.assignedDeptId as string | null) ?? null)
        assertAssignLink(assignType, deptId)
        if (draft.remarks !== undefined) {
          draft.remarks = draft.remarks == null ? null : String(draft.remarks)
        }
      },
      beforeDelete: async (trx, { item }) => {
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type = 'mfg_demand_item'
            AND owner_id IN (SELECT id FROM mfg_demand_item WHERE demand_id = ${String(item.id)}::uuid)
        `.execute(trx)
      },
    },
    workflow: {
      mutableMessage: '仅草稿履约需求单可修改或删除',
      transitions: [
        {
          key: 'confirm',
          label: '确认',
          from: ['DRAFT'],
          to: 'CONFIRMED',
          guardMessage: '仅草稿履约需求单可确认',
          effect: async (trx, { before }) => {
            await effectConfirmOccupy(trx, before)
          },
        },
        {
          key: 'close',
          label: '关闭',
          from: ['CONFIRMED'],
          to: 'CLOSED',
          guardMessage: '仅已确认履约需求单可关闭',
        },
        {
          key: 'void',
          label: '作废',
          from: ['CONFIRMED'],
          to: 'VOIDED',
          guardMessage: '仅已确认履约需求单可作废;草稿请直接删除',
          effect: async (trx, { before }) => {
            await effectVoidDownstream(trx, before)
          },
        },
      ],
    },
  })

  const items = createStandardChildService<DemandItem>({
    db,
    registry,
    resource: DEMAND_ITEM_RESOURCE,
    notFound: '需求行不存在',
    defaultOrder: sql`"idx" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: '制造数据已存在' },
      { code: '23503', message: '制造数据已被业务引用,不可删除' },
    ],
    recordLabel: (item) => String(item.idx),
    derivedFields: [...ITEM_DERIVED],
    projection: {
      source: ITEM_SOURCE,
      alias: DEMAND_ITEM_TABLE,
      mapExtra: mapItemExtras,
    },
    parent: {
      resource: DEMAND_RESOURCE,
      fkField: 'demandId',
      notFound: '履约需求单不存在',
      inheritFields: ['companyId'],
      gate: (parent) => {
        if (String(parent.status) !== 'DRAFT') {
          throw new ApiError('conflict', '仅草稿履约需求单可编辑需求行')
        }
      },
    },
    extraWhere: ({ query }) => {
      const companyId = typeof query.companyId === 'string' ? query.companyId : null
      const demandId = typeof query.demandId === 'string' ? query.demandId : null
      const parts = [
        companyId ? sql`company_id = ${companyId}` : null,
        demandId ? sql`demand_id = ${demandId}` : null,
      ].filter(Boolean)
      return {
        where: parts.length ? sql`${sql.join(parts as never, sql` AND `)}` : null,
      }
    },
    hooks: {
      validate: ({ draft }) => {
        if (draft.needDate === undefined || draft.needDate === null || draft.needDate === '') {
          throw ApiError.validation('需求行参数不合法', { needDate: ['必填'] })
        }
        validateRemarks(draft.remarks as string | null | undefined)
      },
      beforeWrite: async (trx, { action, draft, parent, before }) => {
        draft.needDate = toDateOnly(String(draft.needDate))
        draft.fulfillmentMethod = null
        if (action === 'create') {
          draft.status = 'PENDING'
          draft.orderedQty = '0'
          draft.receivedQty = '0'
          draft.arrangedQty = '0'
          draft.completedQty = '0'
          if (draft.salesOrderItemId === undefined || draft.salesOrderItemId === '') {
            draft.salesOrderItemId = null
          }
        } else if (before) {
          const nextSales =
            draft.salesOrderItemId === undefined
              ? before.salesOrderItemId
              : draft.salesOrderItemId === ''
                ? null
                : draft.salesOrderItemId
          if ((nextSales ?? null) !== (before.salesOrderItemId ?? null)) {
            throw ApiError.validation('需求行参数不合法', {
              salesOrderItemId: ['来源销售订单条目创建后不可改'],
            })
          }
          draft.salesOrderItemId = before.salesOrderItemId ?? null
        }
        const salesId =
          draft.salesOrderItemId == null || draft.salesOrderItemId === ''
            ? null
            : String(draft.salesOrderItemId)
        const sourceWo =
          action === 'update' && before
            ? ((before.sourceWorkOrderId as string | null) ?? null)
            : null
        if (salesId != null && sourceWo != null) {
          throw ApiError.validation('需求行参数不合法', {
            salesOrderItemId: ['来源销售订单条目与来源生产工单互斥,只能二选一'],
          })
        }
        await validateSalesSource(trx, salesId, String(parent.companyId))
        const projection = await deriveItemProjection(
          trx,
          String(draft.materialId),
          String(draft.unitId),
          String(draft.qty),
        )
        draft.qty = toDecimalString(decimal(String(draft.qty)))
        draft.baseQty = projection.baseQty
        draft.materialCode = projection.materialCode
        draft.materialName = projection.materialName
        draft.materialSpec = projection.materialSpec
        draft.unitName = projection.unitName
        draft.remarks = draft.remarks == null ? null : String(draft.remarks)
      },
      afterWrite: async (trx, { item, parent, before }) => {
        const materialId = String(item.materialId)
        if (!before || String(before.materialId) !== materialId) {
          await syncDrawingAttachments(
            trx,
            'mfg_demand_item',
            String(item.id),
            materialId,
            String(parent.companyId),
          )
        }
      },
      beforeDelete: async (trx, { item }) => {
        await sql`
          DELETE FROM sys_attachment
          WHERE owner_type = 'mfg_demand_item' AND owner_id = ${String(item.id)}::uuid
        `.execute(trx)
      },
    },
  })

  const aggregate = createAggregateService({
    db,
    registry,
    head: heads,
    validationMessage: '履约需求单草稿参数不合法',
    children: [{ key: 'items', service: items }],
  })

  function headCreatePayload(input: {
    companyId: string
    demandNo?: string | null
    demandDate?: string | null
    assignType?: string | null
    needDate?: string | null
    remarks?: string | null
    assignedDeptId?: string | null
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      companyId: input.companyId,
      assignType: input.assignType,
      needDate: input.needDate ?? null,
      remarks: input.remarks ?? null,
      assignedDeptId: input.assignedDeptId ?? null,
    }
    if (input.demandDate != null && input.demandDate !== '') payload.demandDate = input.demandDate
    if (input.demandNo != null && String(input.demandNo).trim() !== '') {
      payload.demandNo = input.demandNo
    }
    return payload
  }

  function headUpdatePatch(input: {
    demandNo?: string
    demandDate?: string
    assignType?: string | null
    assignTypePresent?: boolean
    needDate?: string | null
    needDatePresent?: boolean
    remarks?: string | null
    remarksPresent?: boolean
    assignedDeptId?: string | null
    assignedDeptIdPresent?: boolean
  }): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (input.demandNo !== undefined) patch.demandNo = input.demandNo
    if (input.demandDate !== undefined) patch.demandDate = input.demandDate
    if (input.assignTypePresent) patch.assignType = input.assignType
    if (input.needDatePresent) patch.needDate = input.needDate ?? null
    if (input.remarksPresent) patch.remarks = input.remarks ?? null
    if (input.assignedDeptIdPresent) patch.assignedDeptId = input.assignedDeptId ?? null
    return patch
  }

  function itemCreatePayload(input: {
    demandId: string
    idx: number
    materialId: string
    unitId: string
    qty: string
    needDate?: string | null
    salesOrderItemId?: string | null
    remarks?: string | null
  }): Record<string, unknown> {
    return {
      demandId: input.demandId,
      idx: input.idx,
      materialId: input.materialId,
      unitId: input.unitId,
      qty: input.qty,
      needDate: input.needDate,
      salesOrderItemId: input.salesOrderItemId ?? null,
      remarks: input.remarks ?? null,
    }
  }

  function itemUpdatePatch(input: {
    idx?: number
    materialId?: string
    unitId?: string
    qty?: string
    needDate?: string | null
    needDatePresent?: boolean
    /** 已废弃：路由仍可传，忽略 */
    fulfillmentMethod?: string
    /** 路由仍可传；钩子在 before 上拒绝改键 */
    salesOrderItemId?: string | null
    salesOrderItemIdPresent?: boolean
    remarks?: string | null
    remarksPresent?: boolean
  }): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (input.idx !== undefined) patch.idx = input.idx
    if (input.materialId !== undefined) patch.materialId = input.materialId
    if (input.unitId !== undefined) patch.unitId = input.unitId
    if (input.qty !== undefined) patch.qty = input.qty
    if (input.needDatePresent) patch.needDate = input.needDate
    // 改键检测：带不同 salesOrderItemId 时注入以触发钩子校验（同值则省略）
    if (input.salesOrderItemIdPresent) {
      patch.salesOrderItemId = input.salesOrderItemId ?? null
    }
    if (input.remarksPresent) patch.remarks = input.remarks ?? null
    return patch
  }

  const side = createDemandSideActions(db, demandTarget, itemTarget, items)

  return {
    createDemand: async (permit: Permit, input: Parameters<typeof headCreatePayload>[0]) =>
      presentHead(await heads.create(permit, headCreatePayload(input))),
    getDemand: async (permit: Permit, id: string) => presentHead(await heads.get(permit, id)),
    listDemands: async (permit: Permit, query: ListQueryInput) => {
      const q = normalizeList(query)
      const result = await heads.list(permit, q as Partial<ListQuery>)
      return { count: result.count, results: result.results.map((r) => presentHead(r)) }
    },
    updateDemand: async (
      permit: Permit,
      id: string,
      input: Parameters<typeof headUpdatePatch>[0],
    ) => presentHead(await heads.update(permit, id, headUpdatePatch(input))),
    deleteDemand: (permit: Permit, id: string) => heads.remove(permit, id),
    createDemandItem: async (permit: Permit, input: Parameters<typeof itemCreatePayload>[0]) =>
      presentItem(await items.create(permit, itemCreatePayload(input))),
    getDemandItem: async (permit: Permit, id: string) => presentItem(await items.get(permit, id)),
    listDemandItems: async (permit: Permit, query: ListQueryInput & { demandId?: string }) => {
      const q = normalizeList(query)
      const result = await items.list(permit, {
        ...q,
        demandId: query.demandId,
      } as Partial<ListQuery> & { demandId?: string })
      return { count: result.count, results: result.results.map((r) => presentItem(r)) }
    },
    updateDemandItem: async (
      permit: Permit,
      id: string,
      input: Parameters<typeof itemUpdatePatch>[0],
    ) => presentItem(await items.update(permit, id, itemUpdatePatch(input))),
    deleteDemandItem: (permit: Permit, id: string) => items.remove(permit, id),
    confirmDemand: async (permit: Permit, id: string) =>
      presentHead(await heads.transition(permit, id, 'confirm')),
    closeDemand: async (permit: Permit, id: string) =>
      presentHead(await heads.transition(permit, id, 'close')),
    voidDemand: async (permit: Permit, id: string) =>
      presentHead(await heads.transition(permit, id, 'void')),
    ...side,
    _aggregateForContract: (): AggregateService => aggregate,
    _headsForContract: (): StandardService => heads as unknown as StandardService,
    _itemsForContract: (): StandardChildService => items as unknown as StandardChildService,
  }
}

export type DemandService = ReturnType<typeof createDemandService>
