import { api, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { AggregateDraftAdapter } from './catalog/types'

export interface PurchaseReceiptDraftItem {
  id?: string
  idx: number
  qty: string
  orderItemId: string
  unitId?: string | null
  warehouseId: string
  remarks?: string | null
}

export interface PurchaseReceiptDraft {
  companyId: string
  receiptNo?: string | null
  receiptDate?: string | null
  postingDate?: string | null
  partyType: string
  partyId: string
  remarks?: string | null
  warehouseId?: string | null
  debitAccountId: string
  creditAccountId: string
  items: PurchaseReceiptDraftItem[]
}

/** 后端返回的权威聚合快照：表头与全部入库条目。 */
export type PurchaseReceiptSavedDraft = Row & {
  items: Row[]
}

function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function requiredString(value: unknown, label: string): string {
  const result = nullableString(value)
  if (result == null) throw new Error(`${label}不能为空`)
  return result
}

/**
 * 把表单状态收口成采购入库聚合草稿。
 * 展示快照字段不进入 wire input；物料与单位由订单条目在后端重新派生。
 */
export function buildPurchaseReceiptDraft(
  values: Record<string, unknown>,
  rows: Row[],
): PurchaseReceiptDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    receiptNo: nullableString(values.receiptNo),
    receiptDate: nullableString(values.receiptDate),
    postingDate: nullableString(values.postingDate),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    remarks: nullableString(values.remarks),
    warehouseId: nullableString(values.warehouseId),
    debitAccountId: requiredString(values.debitAccountId, '借方科目'),
    creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
    items: rows.map((row) => ({
      ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
      idx: Number(row.idx),
      qty: requiredString(row.qty, `第${String(row.idx)}行数量`),
      orderItemId: requiredString(
        row.orderItemId,
        `第${String(row.idx)}行订单条目`,
      ),
      unitId: nullableString(row.unitId),
      warehouseId: requiredString(
        row.warehouseId,
        `第${String(row.idx)}行仓库`,
      ),
      remarks: nullableString(row.remarks),
    })),
  }
}

function wireDraft(input: PurchaseReceiptDraft): PurchaseReceiptDraft {
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      qty: String(item.qty),
    })),
  }
}

/** production Hono Adapter：一次请求跨越采购入库聚合写 seam。 */
export const purchaseReceiptDraftAdapter: AggregateDraftAdapter<
  PurchaseReceiptDraft,
  PurchaseReceiptSavedDraft
> = {
  async loadDraft(id) {
    return apiData(
      api.purchase.receipts[':id'].draft.$get({ param: { id } }),
    )
  },
  async createDraft(input) {
    return apiData(
      api.purchase.receipts.$post({
        json: wireDraft(input) as never,
      }),
    )
  },
  async replaceDraft(id, input) {
    return apiData(
      api.purchase.receipts[':id'].$put({
        param: { id },
        json: wireDraft(input) as never,
      }),
    )
  },
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 测试 Adapter：与 production Adapter 共享同一 interface。
 * replace 先完成身份校验和下一快照构造，再一次性换入，模拟原子可见性。
 */
export function createInMemoryPurchaseReceiptDraftAdapter(
  initial: PurchaseReceiptSavedDraft[] = [],
): AggregateDraftAdapter<PurchaseReceiptDraft, PurchaseReceiptSavedDraft> {
  const drafts = new Map(initial.map((draft) => [draft.id, clone(draft)]))
  let nextHead = initial.length + 1
  let nextItem =
    initial.reduce((count, draft) => count + draft.items.length, 0) + 1

  const savedFrom = (
    input: PurchaseReceiptDraft,
    id: string,
    previous?: PurchaseReceiptSavedDraft,
  ): PurchaseReceiptSavedDraft => {
    const existingItemIds = new Set(previous?.items.map((item) => item.id) ?? [])
    const seenItemIds = new Set<string>()
    const items = input.items.map((item) => {
      if (item.id != null) {
        if (!existingItemIds.has(item.id)) {
          throw new Error(`条目 ${item.id} 不属于采购入库单 ${id}`)
        }
        if (seenItemIds.has(item.id)) {
          throw new Error(`条目 ${item.id} 在同一草稿中重复`)
        }
        seenItemIds.add(item.id)
      }
      return {
        ...item,
        id: item.id ?? `receipt-item-${nextItem++}`,
        receiptId: id,
      } as Row
    })
    return {
      ...(previous ?? {}),
      ...input,
      id,
      status: previous?.status ?? 'DRAFT',
      items,
    } as PurchaseReceiptSavedDraft
  }

  return {
    async loadDraft(id) {
      const draft = drafts.get(id)
      if (!draft) throw new Error(`采购入库单 ${id} 不存在`)
      return clone(draft)
    },
    async createDraft(input) {
      if (input.items.some((item) => item.id != null)) {
        throw new Error('新采购入库草稿不能包含持久化条目 id')
      }
      const id = `receipt-${nextHead++}`
      const saved = savedFrom(input, id)
      drafts.set(id, clone(saved))
      return clone(saved)
    },
    async replaceDraft(id, input) {
      const previous = drafts.get(id)
      if (!previous) throw new Error(`采购入库单 ${id} 不存在`)
      const saved = savedFrom(input, id, previous)
      drafts.set(id, clone(saved))
      return clone(saved)
    },
  }
}
