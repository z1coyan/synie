/**
 * 订单收发货历史只读投影（scm_order_flow_item 视图）。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 'read')`，「四种来源单据 read 的 OR」是 meta 的
 * `authz.readAnyOf` 声明（声明即执行），本服务不再手写析取，也不再手滚公司谓词。
 * 留在服务层的只有领域语义：orderId/orderItemId 锚点筛选与 id 格式校验。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely, RawBuilder } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { compileRowFilter, conjunction } from '~/db/authz-sql.ts'
import { ident } from '~/db/ident.ts'
import { listAuthorized } from '~/db/list.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import {
  asDate,
  asOptionalString,
  upperStatus,
  wireRequiredDecimal,
} from '../../trading/common.ts'
import { orderFlowItemMeta } from './meta.ts'

export const FLOW_RESOURCE = 'scmOrderFlowItems'

const META = orderFlowItemMeta()

/** 列表与单条共用同一份投影：别名只有一处可写错（须与 source 逐字一致） */
const FLOW_ALIAS = 'scm_order_flow_item'
const FLOW_SOURCE = sql` FROM scm_order_flow_item`
const FLOW_SELECT = sql`SELECT id,flow_type,voucher_no,voucher_date,status,company_id,
  order_id,order_item_id,material_code,material_name,material_spec,
  customer_part_no,unit_name,qty`

const FLOW_PREFIXES = new Set([
  'purchase_receipt',
  'outsourced_issue',
  'outsourced_receipt',
  'sales_delivery',
  'sales_return',
  'purchase_return',
  'outsourced_return',
])

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createOrderFlowService(db: Kysely<Database>, registry: Registry) {
  const target = registry.authzTarget(FLOW_RESOURCE)

  async function get(permit: Permit, id: string) {
    if (!validFlowId(id)) {
      throw ApiError.validation('订单收发货历史行参数不合法', { id: ['格式不合法'] })
    }
    // 本视图主键是「单据类型:uuid」文本，不能走 loadAuthorized 的 ::uuid 转换，故直接编译行过滤拼进 WHERE
    const where = compileRowFilter(permit, target, FLOW_ALIAS)
    const rows = await sql<Record<string, unknown>>`
      ${FLOW_SELECT}${FLOW_SOURCE}
      WHERE ${ident(FLOW_ALIAS)}.id = ${id} AND ${where}
    `.execute(db)
    if (!rows.rows[0]) throw new ApiError('not_found', '订单收发货历史行不存在')
    return mapDto(rows.rows[0])
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    const filter = { ...(query.filter ?? {}) } as Record<string, unknown>
    const orderId = takeAnchor(filter, 'orderId')
    const orderItemId = takeAnchor(filter, 'orderItemId')
    const anchors: RawBuilder<unknown>[] = []
    if (orderId) anchors.push(sql`"order_id"=${orderId}::uuid`)
    if (orderItemId) anchors.push(sql`"order_item_id"=${orderItemId}::uuid`)

    return listAuthorized({
      db,
      permit,
      target,
      alias: FLOW_ALIAS,
      resource: META,
      source: FLOW_SOURCE,
      select: FLOW_SELECT,
      defaultOrder: sql`"voucher_date" DESC, "id" ASC`,
      query: { ...query, filter: filter as ListQuery['filter'] },
      extraWhere: anchors.length > 0 ? conjunction(anchors) : null,
      mapRow: mapDto,
    })
  }

  return { get, list }
}

export type OrderFlowService = ReturnType<typeof createOrderFlowService>

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
