import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { aggregateDraftTransport } from './aggregate-draft-transport'
import { createRowCommandAdapter } from './catalog/commands'
import type { AggregateDraftAdapter } from './catalog/types'
import { restTransport } from './rest-transport'
import { decimalWireInput } from './resource-wire'

type ReturnAuditRequest = Record<string, unknown>

export async function auditSalesReturn(
  id: string,
  _input?: ReturnAuditRequest,
) {
  return apiData(api.sales.returns[':id'].audit.$post({ param: { id } }))
}

export async function voidSalesReturn(id: string) {
  return apiData(api.sales.returns[':id'].void.$post({ param: { id } }))
}

export const salesReturnCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditSalesReturn,
    affectedResources: [
      'salReturnItems',
      'salDeliveryItems',
      'salOrderItems',
      'invStockEntries',
      'accGlEntries',
    ],
  },
  void: {
    handler: voidSalesReturn,
    affectedResources: [
      'salReturnItems',
      'salDeliveryItems',
      'salOrderItems',
      'invStockEntries',
      'accGlEntries',
    ],
  },
})

/**
 * 销售退货聚合草稿 Adapter：完整 load + 原子 create/replace。
 * 表单走 draft，不暴露 RecordWriter 的 create/update。
 */
export interface SalesReturnDraftItemInput {
  id?: string
  idx: number
  qty: string
  /** 源单行锚点：已审核未作废且剩余可退 > 0 的发货条目；留空即手工行 */
  deliveryItemId?: string | null
  /** 手工行必填(物料)；源单行由发货快照覆盖 */
  materialId?: string | null
  /** 原币含税单价：手工行手填；源单行随快照 */
  orderPrice?: string | null
  /** 税率：手工行手填；源单行随快照 */
  orderTaxRate?: string | null
  unitId?: string | null
  /** 行仓:库存类物料必填(后端校验),虚拟行可空 */
  warehouseId: string | null
  remarks?: string | null
}

export interface SalesReturnDraftInput {
  companyId: string
  returnNo?: string | null
  returnDate?: string | null
  postingDate?: string | null
  partyType: string
  partyId: string
  currencyId?: string | null
  exchangeRate?: string | null
  remarks?: string | null
  warehouseId?: string | null
  debitAccountId: string
  creditAccountId: string
  /** 完整快照字段；省略与显式清空语义不同，因此不可选。 */
  items: SalesReturnDraftItemInput[]
}

/** 权威 SavedDraft：表头 + 全部 items */
export type SalesReturnSavedDraft = Row & {
  items: Row[]
}

function draftRecord(value: unknown, path: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`销售退货草稿 ${path} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function draftArray(
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
): unknown[] {
  const value = record[field]
  if (!Array.isArray(value)) {
    throw new TypeError(`销售退货草稿 ${path} 必须显式提交数组`)
  }
  return value
}

/**
 * Aggregate Draft → wire 的唯一转换入口。
 * 集合字段 fail-closed：缺失、null 或非数组不能被解释为“清空全部子项”。
 */
export function salesReturnDraftInput(
  input: SalesReturnDraftInput,
): SalesReturnDraftInput {
  const record = draftRecord(input, '根对象')
  const items = draftArray(record, 'items', 'items').map((item, itemIndex) =>
    decimalWireInput(
      draftRecord(item, `items[${itemIndex}]`),
      ['qty'],
    ) as unknown as SalesReturnDraftItemInput,
  )
  return { ...input, items }
}

/**
 * 测试可注入的 gateway port：与 production 端点三连同形，
 * 供 wire 校验单测在无 HTTP 下录制 create/replace 请求。
 */
export interface SalesReturnDraftGateway {
  loadDraft(id: string): Promise<SalesReturnSavedDraft>
  createDraft(input: SalesReturnDraftInput): Promise<SalesReturnSavedDraft>
  replaceDraft(
    id: string,
    input: SalesReturnDraftInput,
  ): Promise<SalesReturnSavedDraft>
}

/** 测试 Adapter：wire 后委托 gateway（不经 HTTP）。 */
export function createSalesReturnDraftAdapter(
  gateway: SalesReturnDraftGateway,
): AggregateDraftAdapter<
  SalesReturnDraftInput,
  SalesReturnSavedDraft
> {
  return {
    loadDraft: (id) => gateway.loadDraft(id),
    async createDraft(input) {
      const wire = salesReturnDraftInput(input)
      return gateway.createDraft(wire)
    },
    async replaceDraft(id, input) {
      const wire = salesReturnDraftInput(input)
      return gateway.replaceDraft(id, wire)
    },
  }
}

/** production：标准草稿三连 + 领域 wire。 */
export const salesReturnDraftAdapter = aggregateDraftTransport<
  SalesReturnDraftInput,
  SalesReturnSavedDraft
>(api.sales.returns, { wire: salesReturnDraftInput })

export const salesReturnClient = restTransport(
  'salReturns',
  api.sales.returns,
  { capabilities: { create: false, update: false } },
)

export const salesReturnItemClient = restTransport(
  'salReturnItems',
  api.sales['return-items'],
  { capabilities: { create: false, update: false, delete: false } },
)
