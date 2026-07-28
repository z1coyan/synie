/**
 * 订单收发货历史只读投影（scm_order_flow_item 视图）。
 * 权限为四种来源单据 read 的 OR；orderId/orderItemId 作锚点筛选。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { hasPermission, type Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { companyScopeWhere, listFromSource } from '../../base/list.ts'
import {
  asDate,
  asOptionalString,
  upperStatus,
  wireRequiredDecimal,
} from '../../trading/common.ts'
import { ORDER_FLOW_SOURCE_READ_PERMISSIONS, orderFlowItemMeta } from './meta.ts'

const FLOW_PREFIXES = new Set([
  'purchase_receipt',
  'outsourced_issue',
  'outsourced_receipt',
  'sales_delivery',
])

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createOrderFlowService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string) {
    requireRead(actor)
    if (!validFlowId(id)) {
      throw ApiError.validation('订单收发货历史行参数不合法', { id: ['格式不合法'] })
    }
    const scope = companyScopeWhere(actor)
    if (scope.empty) throw new ApiError('not_found', '订单收发货历史行不存在')
    const extra = scope.where
      ? sql`id=${id} AND ${scope.where}`
      : sql`id=${id}`
    const rows = await sql<Record<string, unknown>>`
      SELECT id,flow_type,voucher_no,voucher_date,status,company_id,
        order_id,order_item_id,material_code,material_name,material_spec,
        customer_part_no,unit_name,qty
      FROM scm_order_flow_item WHERE ${extra}
    `.execute(db)
    if (!rows.rows[0]) throw new ApiError('not_found', '订单收发货历史行不存在')
    return mapDto(rows.rows[0])
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    requireRead(actor)
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as Record<string, unknown>[] }

    const filter = { ...(query.filter ?? {}) } as Record<string, unknown>
    const orderId = takeAnchor(filter, 'orderId')
    const orderItemId = takeAnchor(filter, 'orderItemId')
    const extras = [scope.where]
    if (orderId) extras.push(sql`"order_id"=${orderId}::uuid`)
    if (orderItemId) extras.push(sql`"order_item_id"=${orderItemId}::uuid`)
    const extraWhere =
      extras.filter(Boolean).length > 0
        ? sql`${sql.join(extras.filter((x): x is NonNullable<typeof x> => x != null), sql` AND `)}`
        : null

    return listFromSource({
      db,
      resource: orderFlowItemMeta(),
      source: sql` FROM scm_order_flow_item`,
      select: sql`SELECT id,flow_type,voucher_no,voucher_date,status,company_id,
        order_id,order_item_id,material_code,material_name,material_spec,
        customer_part_no,unit_name,qty`,
      defaultOrder: sql`"voucher_date" DESC, "id" ASC`,
      query: { ...query, filter: filter as ListQuery['filter'] },
      extraWhere,
      mapRow: mapDto,
    })
  }

  return { get, list }
}

export type OrderFlowService = ReturnType<typeof createOrderFlowService>

function requireRead(actor: Actor) {
  const ok = ORDER_FLOW_SOURCE_READ_PERMISSIONS.some((p) => hasPermission(actor, p))
  if (!ok) throw new ApiError('forbidden', '无权限读取订单收发货历史')
}

function validFlowId(id: string): boolean {
  const idx = id.indexOf(':')
  if (idx < 0) return false
  const prefix = id.slice(0, idx)
  const raw = id.slice(idx + 1)
  return FLOW_PREFIXES.has(prefix) && UUID_RE.test(raw)
}

function takeAnchor(filter: Record<string, unknown>, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(filter, field)) return null
  const raw = filter[field]
  delete filter[field]
  if (!raw || typeof raw !== 'object') {
    throw ApiError.validation('订单收发货历史筛选条件错误', {
      [field]: ['须为仅含一个 UUID 的 fk/in 筛选'],
    })
  }
  const value = raw as { kind?: string; op?: string; values?: unknown[] }
  if (
    value.kind !== 'fk' ||
    (value.op !== undefined && value.op !== '' && value.op !== 'in') ||
    !Array.isArray(value.values) ||
    value.values.length !== 1 ||
    typeof value.values[0] !== 'string' ||
    !UUID_RE.test(value.values[0].trim())
  ) {
    throw ApiError.validation('订单收发货历史筛选条件错误', {
      [field]: ['须为仅含一个 UUID 的 fk/in 筛选'],
    })
  }
  return value.values[0].trim()
}

function mapDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    flowType: upperStatus(String(row.flow_type)),
    voucherNo: String(row.voucher_no),
    voucherDate: asDate(row.voucher_date),
    status: upperStatus(String(row.status)),
    companyId: String(row.company_id),
    orderId: String(row.order_id),
    orderItemId: String(row.order_item_id),
    materialCode: String(row.material_code),
    materialName: String(row.material_name),
    materialSpec: asOptionalString(row.material_spec),
    customerPartNo: asOptionalString(row.customer_part_no),
    unitName: String(row.unit_name),
    qty: wireRequiredDecimal(String(row.qty)),
  }
}
