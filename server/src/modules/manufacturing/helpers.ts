/**
 * 制造域共享工具：单号/数量/日期 wire、物料与单位折算、需求行投影调整。
 *
 * 鉴权不在本文件：路由挂 `guard(资源, 动作)`，服务收 Permit，
 * 三个执行点（listAuthorized / loadAuthorized / assertCompanyWritable）由平台拥有。
 * 「持 create 或 update 均可」的多码析取归 guard 的 `anyOf`（本地包装已删）。
 */
import { decimal, isDecimalString, toDecimalString } from '@synie/shared'
import { sql } from 'kysely'
import { toDateOnly } from '~/db/dates.ts'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { mapWriteError, type PgWriteMapping } from '~/db/dberr.ts'
import type { DemandItemStatus, ListQueryInput } from './types.ts'

export { toDateOnly }

/** 制造域写错映射（标准动作内核的 writeErrors 与 mfgWriteError 共用同一张表） */
export const MFG_WRITE_MAPPINGS: readonly PgWriteMapping[] = [
  { code: '23505', constraint: 'mfg_work_order_active_demand_item', message: '该需求行已有未作废生产工单' },
  { code: '23505', constraint: 'mfg_demand_unique_demand_no', message: '需求单号已存在' },
  { code: '23505', constraint: 'mfg_work_order_unique_work_order_no', message: '工单号已存在' },
  { code: '23505', constraint: 'mfg_output_unique_output_no', message: '生产入库单号已存在' },
  { code: '23505', constraint: 'mfg_operation', message: '工序编号已存在' },
  { code: '23505', constraint: 'mfg_process_template', message: '工艺模板编号已存在' },
  { code: '23505', constraint: 'mfg_bom', message: 'BOM 编号已存在' },
  { code: '23505', message: '制造数据已存在' },
  { code: '23503', message: '制造数据已被业务引用,不可删除' },
]

export function mfgWriteError(fallback: string, err: unknown, extra: readonly PgWriteMapping[] = []): ApiError {
  return mapWriteError(err, fallback, [...extra, ...MFG_WRITE_MAPPINGS])
}

export function trimOptional(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t === '' ? null : t
}

export function runeCount(s: string): number {
  return [...s].length
}

export function validateNo(no: string, field: string): void {
  if (!no.trim() || runeCount(no) > 32) {
    throw ApiError.validation('单号参数不合法', { [field]: ['不能为空且最多 32 个字符'] })
  }
}

export function validateRemarks(remarks: string | null | undefined, max = 512): void {
  if (remarks != null && runeCount(remarks) > max) {
    throw ApiError.validation('备注参数不合法', { remarks: [`最多 ${max} 个字符`] })
  }
}

export function parsePositiveQty(raw: string, field = 'qty'): string {
  if (!isDecimalString(raw)) {
    throw ApiError.validation('数量参数不合法', { [field]: ['必须为有效十进制数字'] })
  }
  const v = decimal(raw)
  if (!v.gt(0)) {
    throw ApiError.validation('数量参数不合法', { [field]: ['必须大于 0'] })
  }
  return toDecimalString(v)
}

/** 制造域物料投影 / base_qty：实现见 platform/posting/material-qty（W0 T0.1） */
export {
  deriveItemProjection,
  type MfgItemProjection as ItemProjection,
} from '~/platform/posting/material-qty.ts'

export async function ensureMaterial(
  db: DbHandle,
  materialId: string,
  allowedTypes: readonly string[] = ['STOCK'],
  label = 'BOM',
): Promise<void> {
  const row = await db
    .selectFrom('inv_material')
    .select(['id', 'material_type'])
    .where('id', '=', materialId)
    .executeTakeFirst()
  if (!row) {
    throw ApiError.validation(`${label}参数不合法`, { materialId: ['物料不存在'] })
  }
  if (!allowedTypes.includes(row.material_type)) {
    throw ApiError.validation(`${label}参数不合法`, {
      materialId: ['仅库存类物料可进该单据'],
    })
  }
}

export async function ensureUnitAllowed(
  db: DbHandle,
  materialId: string,
  unitId: string,
): Promise<void> {
  if (!unitId) {
    throw ApiError.validation('BOM行参数不合法', { unitId: ['必填'] })
  }
  const row = await sql<{ ok: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM inv_material m WHERE m.id = ${materialId} AND m.default_unit_id = ${unitId}
      UNION ALL
      SELECT 1 FROM inv_material_unit mu WHERE mu.material_id = ${materialId} AND mu.unit_id = ${unitId}
    ) AS ok
  `.execute(db)
  if (!row.rows[0]?.ok) {
    throw ApiError.validation('BOM行参数不合法', {
      unitId: ['单位必须是该物料默认单位或转换单位'],
    })
  }
}

export async function validateWarehouse(
  db: DbHandle,
  warehouseId: string | null | undefined,
  companyId: string,
  field = 'warehouseId',
): Promise<void> {
  if (warehouseId == null) return
  const wh = await db
    .selectFrom('inv_warehouse')
    .select(['company_id', 'is_leaf', 'active'])
    .where('id', '=', warehouseId)
    .executeTakeFirst()
  if (!wh) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仓库不存在'] })
  }
  if (wh.company_id !== companyId) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仓库不属于本公司'] })
  }
  if (!wh.is_leaf) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仅叶子仓可入库'] })
  }
  if (!wh.active) {
    throw ApiError.validation('生产入库仓库不合法', { [field]: ['仓库已停用'] })
  }
}

export async function validateSalesSource(
  db: DbHandle,
  salesOrderItemId: string | null | undefined,
  companyId: string,
): Promise<void> {
  if (salesOrderItemId == null) return
  const row = await db
    .selectFrom('sal_order_item as i')
    .innerJoin('sal_order as o', 'o.id', 'i.order_id')
    .select(['i.company_id', 'o.status'])
    .where('i.id', '=', salesOrderItemId)
    .executeTakeFirst()
  if (!row) {
    throw ApiError.validation('需求行参数不合法', { salesOrderItemId: ['销售订单条目不存在'] })
  }
  if (row.company_id !== companyId) {
    throw ApiError.validation('需求行参数不合法', {
      salesOrderItemId: ['销售订单条目不属于本公司'],
    })
  }
  if (row.status !== 'audited') {
    throw ApiError.validation('需求行参数不合法', {
      salesOrderItemId: ['仅已审核未关闭的销售订单条目可纳入'],
    })
  }
}

export function normalizeList(query: ListQueryInput) {
  const limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
  const offset = query.offset ?? 0
  if (limit < 1 || limit > 200 || offset < 0) {
    throw ApiError.validation('分页参数不合法', { limit: ['必须在 1 到 200 之间'] })
  }
  return {
    limit,
    offset,
    search: query.search,
    sort: query.sort,
    filter: query.filter as never,
    companyId: query.companyId,
  }
}

/** 采购链投影：调整已下单数量 */
export async function adjustDemandOrdered(
  db: DbHandle,
  id: string,
  delta: string | number,
): Promise<void> {
  const row = await db
    .selectFrom('mfg_demand_item')
    .select('ordered_qty')
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '需求行不存在')
  const next = decimal(String(row.ordered_qty)).add(delta)
  if (next.isNegative()) {
    throw new ApiError('conflict', '已下单数量不能为负')
  }
  await db
    .updateTable('mfg_demand_item')
    .set({
      ordered_qty: toDecimalString(next),
      updated_at: sql`(now() AT TIME ZONE 'utc')`,
    })
    .where('id', '=', id)
    .execute()
}

/** 采购/委外入库投影：调整已收并自动完成/回待办 */
export async function adjustDemandReceived(
  db: DbHandle,
  id: string,
  delta: string | number,
): Promise<void> {
  const row = await db
    .selectFrom('mfg_demand_item')
    .select(['received_qty', 'base_qty'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '需求行不存在')
  const next = decimal(String(row.received_qty)).add(delta)
  if (next.isNegative()) {
    throw new ApiError('conflict', '已收数量不能为负')
  }
  const status: DemandItemStatus = !next.lt(decimal(String(row.base_qty)))
    ? 'completed'
    : 'pending'
  await db
    .updateTable('mfg_demand_item')
    .set({
      received_qty: toDecimalString(next),
      status,
      updated_at: sql`(now() AT TIME ZONE 'utc')`,
    })
    .where('id', '=', id)
    .execute()
}

export function numStr(v: unknown): string {
  if (v == null) return '0'
  return toDecimalString(decimal(String(v)))
}

export function asDate(v: unknown): string {
  if (v instanceof Date) return toDateOnly(v)
  if (typeof v === 'string') return toDateOnly(v)
  return toDateOnly(String(v))
}

export function asDateOrNull(v: unknown): string | null {
  if (v == null) return null
  return asDate(v)
}

export function asInt(v: unknown): number {
  if (typeof v === 'bigint') return Number(v)
  return Number(v)
}
