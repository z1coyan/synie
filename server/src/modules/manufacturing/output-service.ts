/**
 * 生产入库：单头与入库行均走标准动作内核（platform/standard）。
 *
 * 审核/作废迁 workflow 转移（shapes.ts 登记形状 inventory-doc）：effect 只做
 * 「收集校验 → 库存引擎 → 工单/需求投影回写」，状态翻转 / 盖章 / 审计交内核 transition。
 * 引擎复用 engines/inventory，禁止直写分录表。
 *
 * 一处按动作弹射（母单投影原语仍缺，见迁移决策日志）：
 * - `listOutputItems`：行列表 join 母单暴露 output_no/date/status 投影列，
 *   而 create/update/get 逐字冻结为「不带母单投影」（三列出 null）。
 *
 * 单头 `listOutputs` 的 companyId 领域过滤走内核 `extraWhere`（T1.5）。
 *
 * 授权全由平台承担（工单 07）：服务只收 Permit，行谓词由 loadAuthorized/listAuthorized 编译。
 * 入库行引用生产工单，故行的写路由额外要求 `mfg.work_order:read`（guard allOf）——
 * 只能拿自己看得见的工单入库。审核/作废的工单投影是同事务内的系统写，走受信任读。
 */
import { decimal, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { InventoryEngine, StockLine } from '~/engines/inventory/types.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createStandardChildService } from '~/platform/standard/child.ts'
import { mapRow } from '~/platform/standard/fields.ts'
import { auditStamp, createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { listAuthorized } from '~/db/list.ts'
import { utcToday } from '~/db/dates.ts'
import {
  adjustWorkOrderReceived,
  type AfterAdjust,
} from '~/platform/posting/controlled-projection.ts'
import { recomputeDemandItemProjections } from './arrangement.ts'
import {
  MFG_WRITE_MAPPINGS,
  deriveItemProjection,
  mfgWriteError,
  normalizeList,
  parsePositiveQty,
  toDateOnly,
  validateNo,
  validateRemarks,
  validateWarehouse,
} from './helpers.ts'
import { outputItemResourceMeta } from './meta.ts'
import {
  WORK_ORDER_RESOURCE,
  loadWorkOrderAuthorized,
  loadWorkOrderForProjection,
} from './work-order-service.ts'
import type {
  ListQueryInput,
  Output,
  OutputItem,
  OutputStatus,
  WorkOrder,
  WorkOrderStatus,
} from './types.ts'

export const OUTPUT_RESOURCE = 'mfgOutputs'
export const OUTPUT_ITEM_RESOURCE = 'mfgOutputItems'

const ITEM_META = outputItemResourceMeta()

const LABEL = '生产入库单'
const ITEM_LABEL = '生产入库行'
const VOUCHER_TYPE = 'mfg.output'

export function createOutputService(
  db: Kysely<Database>,
  numbering: NumberingService,
  inventory: InventoryEngine,
  registry: Registry,
) {
  const itemTarget = registry.authzTarget(OUTPUT_ITEM_RESOURCE)
  const workOrderTarget = registry.authzTarget(WORK_ORDER_RESOURCE)

  const base: StandardService<Output> = createStandardService<Output>({
    db,
    registry,
    resource: OUTPUT_RESOURCE,
    notFound: `${LABEL}不存在`,
    defaultOrder: sql`"inserted_at" DESC, "id" DESC`,
    writeErrors: MFG_WRITE_MAPPINGS,
    numbering: { service: numbering, field: 'outputNo' },
    // companyId 领域过滤（list 扩展键，非 filter DSL；T1.5）
    extraWhere: ({ query }) => {
      const companyId = typeof query.companyId === 'string' ? query.companyId : null
      return { where: companyId ? sql`company_id = ${companyId}` : null }
    },
    hooks: {
      validate: ({ action, draft }) => {
        if (typeof draft.outputNo === 'string') draft.outputNo = draft.outputNo.trim()
        // 入库日期是库存分录业务日，同时进取号 values（规则段 output_date）；
        // create 缺省当日（空串同缺省，冻结旧口径），update 只做日期切片
        const blankDate =
          draft.outputDate === undefined ||
          draft.outputDate === null ||
          String(draft.outputDate).trim() === ''
        if (action === 'create') {
          draft.outputDate = blankDate ? utcToday() : toDateOnly(String(draft.outputDate))
        } else if (!blankDate) {
          draft.outputDate = toDateOnly(String(draft.outputDate))
        }
        const no = typeof draft.outputNo === 'string' ? draft.outputNo : ''
        // create 未给单号即自动取号（校验落在取号之后），给了则与 update 同校验
        if (action === 'update' || no !== '') validateNo(no, 'outputNo')
        validateRemarks(draft.remarks as string | null | undefined)
      },
      beforeWrite: async (trx, { draft }) => {
        await validateWarehouse(trx, draft.warehouseId as string | null, String(draft.companyId))
      },
      // created_by_id 是 readonly 列且本资源不声明 owner 绑定，随 INSERT 一并落库
      insertColumns: ({ permit }) => ({ created_by_id: permit.actor.userId || null }),
    },
    workflow: {
      mutableMessage: `仅草稿${LABEL}可修改或删除`,
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: `仅草稿${LABEL}可审核`,
          stamps: ({ permit }) => auditStamp(permit),
          effect: async (trx, { before }) => {
            const items = await loadOutputItemsForUpdate(trx, String(before.id))
            const orders = await lockOutputWorkOrders(trx, items)
            await checkOutput(trx, before as Output, items, orders)
            // 审核锁内按当前类型复核：工单创建后物料可能被改为非库存类（尚无分录时允许改）
            const typeRows = await trx
              .selectFrom('inv_material')
              .select(['id', 'material_type'])
              .where('id', 'in', items.map((i) => i.materialId))
              .execute()
            if (typeRows.some((r) => r.material_type !== 'STOCK')) {
              throw new ApiError('conflict', '工单物料类型已变更为非库存类,不能生产入库')
            }
            const stockLines: StockLine[] = items.map((item) => ({
              warehouseId: item.warehouseId,
              materialId: item.materialId,
              quantity: item.baseQty,
              direction: 'in' as const,
              remarks: item.remarks ?? (before.remarks as string | null),
            }))
            if (stockLines.length > 0) {
              await inventory.post(
                trx,
                {
                  type: VOUCHER_TYPE,
                  id: String(before.id),
                  no: String(before.outputNo),
                  companyId: String(before.companyId),
                  postingDate: String(before.outputDate),
                },
                stockLines,
              )
            }
            await updateWorkOrderProjection(trx, orders, 1)
          },
        },
        {
          key: 'void',
          label: '作废',
          from: ['AUDITED'],
          to: 'VOIDED',
          guardMessage: `仅已审核${LABEL}可作废`,
          effect: async (trx, { before }) => {
            const items = await loadOutputItemsForUpdate(trx, String(before.id))
            const orders = await lockOutputWorkOrders(trx, items)
            await updateWorkOrderProjection(trx, orders, -1)
            await inventory.cancel(trx, { type: VOUCHER_TYPE, id: String(before.id) }, new Date())
          },
        },
      ],
    },
  })

  const items = createStandardChildService<OutputItem>({
    db,
    registry,
    resource: OUTPUT_ITEM_RESOURCE,
    notFound: `${ITEM_LABEL}不存在`,
    writeErrors: MFG_WRITE_MAPPINGS,
    parent: {
      resource: OUTPUT_RESOURCE,
      fkField: 'outputId',
      notFound: `${LABEL}不存在`,
      gate: (parent) => {
        if (parent.status !== 'DRAFT') {
          throw new ApiError('conflict', `仅草稿${LABEL}可编辑单据行`)
        }
      },
      inheritFields: ['companyId'],
    },
    // 行充实（工单快照 + 单位折算）在 beforeWrite 写进 draft，随 INSERT/UPDATE 落库
    derivedFields: ['materialId', 'baseQty', 'materialCode', 'materialName', 'materialSpec', 'unitName'],
    recordLabel: (item) => String(item.idx),
    hooks: {
      validate: ({ draft }) => {
        validateRemarks(draft.remarks as string | null | undefined)
      },
      beforeWrite: async (trx, { permit, draft, parent }) => {
        const workOrder = await loadWorkOrderAuthorized(
          trx,
          permit,
          workOrderTarget,
          String(draft.workOrderId),
          false,
        )
        if (workOrder.status === 'voided') {
          throw new ApiError('conflict', '生产工单已作废')
        }
        if (workOrder.companyId !== parent.companyId) {
          throw new ApiError('conflict', '生产工单不属于本公司')
        }
        await validateWarehouse(trx, String(draft.warehouseId), String(parent.companyId))
        const projection = await deriveItemProjection(
          trx,
          workOrder.materialId,
          String(draft.unitId),
          String(draft.qty),
        )
        // 物料快照取工单口径（工单建单时定型），单位与折算取当前单位换算
        draft.materialId = workOrder.materialId
        draft.materialCode = workOrder.materialCode
        draft.materialName = workOrder.materialName
        draft.materialSpec = workOrder.materialSpec
        draft.unitName = projection.unitName
        draft.baseQty = projection.baseQty
      },
    },
  })

  async function createOutput(
    permit: Permit,
    input: {
      companyId: string
      outputNo?: string | null
      outputDate?: string | null
      warehouseId?: string | null
      remarks?: string | null
    },
  ): Promise<Output> {
    return base.create(permit, input)
  }

  async function updateOutput(
    permit: Permit,
    id: string,
    input: {
      outputNo?: string
      outputDate?: string
      warehouseId?: string | null
      warehouseIdPresent?: boolean
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Output> {
    const patch: Record<string, unknown> = {}
    if (input.outputNo !== undefined) patch.outputNo = input.outputNo
    if (input.outputDate !== undefined) patch.outputDate = input.outputDate
    if (input.warehouseIdPresent) patch.warehouseId = input.warehouseId ?? null
    if (input.remarksPresent) patch.remarks = input.remarks ?? null
    return base.update(permit, id, patch)
  }

  async function createOutputItem(
    permit: Permit,
    input: {
      outputId: string
      idx: number
      workOrderId: string
      unitId: string
      qty: string
      warehouseId: string
      remarks?: string | null
    },
  ): Promise<OutputItem> {
    // 数量合法性先于内核 normalizeInput（decimal() 对非法串抛裸错，wire 须保 422）
    parsePositiveQty(input.qty, 'qty')
    return withParentProjection(await items.create(permit, input))
  }

  async function updateOutputItem(
    permit: Permit,
    id: string,
    input: {
      idx?: number
      workOrderId?: string
      unitId?: string
      qty?: string
      warehouseId?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<OutputItem> {
    if (input.qty !== undefined) parsePositiveQty(input.qty, 'qty')
    const patch: Record<string, unknown> = {}
    if (input.idx !== undefined) patch.idx = input.idx
    if (input.workOrderId !== undefined) patch.workOrderId = input.workOrderId
    if (input.unitId !== undefined) patch.unitId = input.unitId
    if (input.qty !== undefined) patch.qty = input.qty
    if (input.warehouseId !== undefined) patch.warehouseId = input.warehouseId
    if (input.remarksPresent) patch.remarks = input.remarks ?? null
    return withParentProjection(await items.update(permit, id, patch))
  }

  /** 行列表（弹射）：join 母单暴露 output_no/date/status，且带 companyId/outputId 过滤 */
  async function listOutputItems(permit: Permit, query: ListQueryInput & { outputId?: string }) {
    const q = normalizeList(query)
    const parts = [
      q.companyId ? sql`company_id = ${q.companyId}` : null,
      query.outputId ? sql`output_id = ${query.outputId}` : null,
    ].filter(Boolean)
    // 列名须与 ResourceMeta.dbColumn 一致（filterbuild 按 apiName→dbColumn 排序筛选）
    return listAuthorized<OutputItem>({
      db,
      permit,
      target: itemTarget,
      alias: 'mfg_output_items',
      resource: ITEM_META,
      source: sql` FROM (
        SELECT i.*, h.output_no, h.output_date, h.status AS output_status
        FROM mfg_output_item i
        JOIN mfg_output h ON h.id = i.output_id
      ) mfg_output_items`,
      select: sql`SELECT *`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query: q,
      extraWhere: parts.length ? sql`${sql.join(parts as never, sql` AND `)}` : null,
      mapRow: mapOutputItemRecord,
    })
  }

  return {
    createOutput,
    getOutput: (permit: Permit, id: string) => base.get(permit, id),
    listOutputs: (permit: Permit, query: ListQueryInput) => base.list(permit, query),
    updateOutput,
    deleteOutput: (permit: Permit, id: string) => base.remove(permit, id),
    createOutputItem,
    getOutputItem: async (permit: Permit, id: string) =>
      withParentProjection(await items.get(permit, id)),
    listOutputItems,
    updateOutputItem,
    deleteOutputItem: (permit: Permit, id: string) => items.remove(permit, id),
    auditOutput: (permit: Permit, id: string) => base.transition(permit, id, 'audit'),
    voidOutput: (permit: Permit, id: string) => base.transition(permit, id, 'void'),

    _headsForContract: (): StandardService => base as unknown as StandardService,
  }
}

export type OutputService = ReturnType<typeof createOutputService>

/** 单条读写不带母单投影（逐字冻结旧形状）：三列显式补 null，不得漏键 */
function withParentProjection(item: OutputItem): OutputItem {
  return {
    ...item,
    outputNo: item.outputNo ?? null,
    outputDate: item.outputDate ?? null,
    outputStatus: item.outputStatus ?? null,
  }
}

/** 列表行：物理列走 meta 映射，join 出的母单三列单独规范化（空串按 null） */
function mapOutputItemRecord(row: Record<string, unknown>): OutputItem {
  const item = mapRow(ITEM_META, row) as OutputItem
  const no = row.output_no
  return {
    ...item,
    outputNo: no == null || no === '' ? null : String(no),
    outputDate: row.output_date == null ? null : toDateOnly(row.output_date as Date | string),
    outputStatus:
      row.output_status == null || row.output_status === ''
        ? null
        : (String(row.output_status).toUpperCase() as OutputStatus),
  }
}

async function loadOutputItemsForUpdate(db: DbHandle, outputId: string): Promise<OutputItem[]> {
  const rows = await db
    .selectFrom('mfg_output_item')
    .selectAll()
    .where('output_id', '=', outputId)
    .orderBy('idx', 'asc')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute()
  return rows.map((row) => mapRow(ITEM_META, row) as OutputItem)
}

interface LockedWorkOrder {
  item: WorkOrder
  add: ReturnType<typeof decimal>
}

async function lockOutputWorkOrders(
  db: DbHandle,
  items: OutputItem[],
): Promise<Map<string, LockedWorkOrder>> {
  const quantities = new Map<string, ReturnType<typeof decimal>>()
  const firstIdx = new Map<string, number>()
  for (const item of items) {
    const prev = quantities.get(item.workOrderId) ?? decimal(0)
    quantities.set(item.workOrderId, prev.add(item.baseQty))
    if (!firstIdx.has(item.workOrderId)) firstIdx.set(item.workOrderId, item.idx)
  }
  const result = new Map<string, LockedWorkOrder>()
  const sorted = [...quantities.keys()].sort()
  for (const id of sorted) {
    try {
      const item = await loadWorkOrderForProjection(db, id)
      result.set(id, { item, add: quantities.get(id)! })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') {
        throw new ApiError('conflict', `第${firstIdx.get(id)}行:生产工单不存在`)
      }
      throw err
    }
  }
  return result
}

async function outputRatio(db: DbHandle): Promise<ReturnType<typeof decimal>> {
  const row = await sql<{ ratio: string }>`
    SELECT coalesce(
      (SELECT output_overreceive_ratio FROM mfg_setting ORDER BY inserted_at, id LIMIT 1),
      0
    )::text AS ratio
  `.execute(db)
  return decimal(row.rows[0]?.ratio ?? '0')
}

async function checkOutput(
  db: TrxHandle,
  output: Output,
  items: OutputItem[],
  orders: Map<string, LockedWorkOrder>,
): Promise<void> {
  if (items.length === 0) {
    throw new ApiError('conflict', '审核前必须至少填写一行入库条目')
  }
  const ratio = await outputRatio(db)
  for (const item of items) {
    const order = orders.get(item.workOrderId)!.item
    if (order.status === 'voided') {
      throw new ApiError('conflict', `第${item.idx}行:生产工单已作废,不可入库`)
    }
    if (order.companyId !== output.companyId) {
      throw new ApiError('conflict', `第${item.idx}行:生产工单不属于本公司`)
    }
    if (order.materialId !== item.materialId) {
      throw new ApiError('conflict', `第${item.idx}行:物料与生产工单不一致`)
    }
    try {
      await validateWarehouse(db, item.warehouseId, output.companyId)
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError('conflict', `第${item.idx}行:${err.message}`)
      }
      throw err
    }
  }
  const ids = [...orders.keys()].sort()
  for (const id of ids) {
    const group = orders.get(id)!
    const maxAllowed = decimal(group.item.baseQty).mul(decimal(1).add(ratio))
    const after = decimal(group.item.receivedBaseQty).add(group.add)
    if (after.gt(maxAllowed)) {
      throw new ApiError(
        'conflict',
        `超出生产入库容差(已入${group.item.receivedBaseQty}+本单${toDecimalString(group.add)} > 工单${group.item.baseQty}×(1+${toDecimalString(ratio)}))`,
      )
    }
  }
}

/** 工单已入投影后倒写需求行安排（rowId = demandItemId） */
const afterWorkOrderReceived: AfterAdjust = async (db, { rowId }) => {
  await recomputeDemandItemProjections(db, rowId)
}

async function updateWorkOrderProjection(
  db: TrxHandle,
  orders: Map<string, LockedWorkOrder>,
  direction: 1 | -1,
): Promise<void> {
  try {
    await adjustWorkOrderReceived(
      db,
      [...orders.entries()].map(([id, { item, add }]) => ({
        workOrderId: id,
        demandItemId: item.demandItemId,
        baseQty: item.baseQty,
        receivedBaseQty: item.receivedBaseQty,
        addQty: add,
      })),
      direction,
      { afterAdjust: afterWorkOrderReceived },
    )
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw mfgWriteError('更新生产工单已入投影失败', err)
  }
}
