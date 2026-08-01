import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { AggregateDraftAdapter } from './catalog/types'

export type OrderSide = 'sales' | 'purchase'

export interface OrderDraftLine {
  id?: string
  materialId: string
  unitId: string
  quantity: string
  remarks: string | null
}

export interface OrderDraftItem {
  id?: string
  idx: number
  qty: string
  materialId: string
  unitId: string
  price: string
  taxRate: string
  remarks: string | null
  quotationItemId: string | null
  bomId?: string | null
  demandLineId?: string | null
  demandDate?: string | null
  issueLines: OrderDraftLine[]
  byproductLines: OrderDraftLine[]
}

export interface OrderDraft {
  companyId: string
  orderNo?: string | null
  orderDate?: string | null
  orderType?: string
  isOutsourced?: boolean
  partyType: string
  partyId: string
  currencyId?: string | null
  exchangeRate?: string | null
  terms?: string | null
  remarks?: string | null
  items: OrderDraftItem[]
}

export type OrderSavedDraft = Row & {
  items: Array<
    Row & {
      issueLines: Row[]
      byproductLines: Row[]
    }
  >
}

function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function requiredString(value: unknown, label: string): string {
  const result = nullableString(value)
  if (result == null) throw new Error(`${label}不能为空`)
  return result
}

function buildLines(
  rows: Row[],
  itemIndex: unknown,
  label: string,
): OrderDraftLine[] {
  return rows.map((row) => ({
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    materialId: requiredString(
      row.materialId,
      `第${String(itemIndex)}行${label}物料`,
    ),
    unitId: requiredString(
      row.unitId,
      `第${String(itemIndex)}行${label}单位`,
    ),
    quantity: requiredString(
      row.quantity,
      `第${String(itemIndex)}行${label}数量`,
    ),
    remarks: nullableString(row.remarks),
  }))
}

/** 表单状态到订单聚合 wire input 的唯一转换入口。 */
export function buildOrderDraft(
  side: OrderSide,
  values: Record<string, unknown>,
  terms: string,
  rows: Row[],
): OrderDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    orderNo: nullableString(values.orderNo),
    orderDate: nullableString(values.orderDate),
    orderType: nullableString(values.orderType) ?? undefined,
    ...(side === 'purchase'
      ? { isOutsourced: Boolean(values.isOutsourced) }
      : {}),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    currencyId: nullableString(values.currencyId),
    exchangeRate: nullableString(values.exchangeRate),
    terms: terms === '' ? null : terms,
    remarks: nullableString(values.remarks),
    items: rows.map((row) => ({
      ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
      idx: Number(row.idx),
      qty: requiredString(row.qty, `第${String(row.idx)}行数量`),
      materialId: requiredString(
        row.materialId,
        `第${String(row.idx)}行物料`,
      ),
      unitId: requiredString(row.unitId, `第${String(row.idx)}行单位`),
      // 常规梯度报价由后端权威套档；本地无价时沿用旧协议占位 0。
      price: nullableString(row.price) ?? '0',
      taxRate: requiredString(row.taxRate, `第${String(row.idx)}行税率`),
      remarks: nullableString(row.remarks),
      quotationItemId: nullableString(row.quotationItemId),
      ...(side === 'purchase'
        ? {
            bomId: nullableString(row.bomId),
            demandLineId: nullableString(row.demandLineId),
            demandDate: nullableString(row.demandDate),
          }
        : {}),
      issueLines:
        side === 'purchase'
          ? buildLines(
              (row.issueLines as Row[] | undefined) ?? [],
              row.idx,
              '发料清单',
            )
          : [],
      byproductLines:
        side === 'purchase'
          ? buildLines(
              (row.byproductLines as Row[] | undefined) ?? [],
              row.idx,
              '副产物清单',
            )
          : [],
    })),
  }
}

function unavailableOrderDraft(side: OrderSide): AggregateDraftAdapter<OrderDraft, OrderSavedDraft> {
  const unavailable = async (): Promise<never> => {
    throw new Error(`${side === 'sales' ? '销售' : '采购'}订单草稿尚未由 Convex 应用壳装配`)
  }
  return { loadDraft: unavailable, createDraft: unavailable, replaceDraft: unavailable }
}

export const salesOrderDraftAdapter = unavailableOrderDraft('sales')
export const purchaseOrderDraftAdapter = unavailableOrderDraft('purchase')

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 测试 Adapter；完整下一快照构造成功后才一次性换入。 */
export function createInMemoryOrderDraftAdapter(
  side: OrderSide,
  initial: OrderSavedDraft[] = [],
): AggregateDraftAdapter<OrderDraft, OrderSavedDraft> {
  const drafts = new Map(initial.map((draft) => [draft.id, clone(draft)]))
  let nextHead = initial.length + 1
  let nextItem =
    initial.reduce((count, draft) => count + draft.items.length, 0) + 1
  let nextLine =
    initial.reduce(
      (count, draft) =>
        count +
        draft.items.reduce(
          (sum, item) =>
            sum + item.issueLines.length + item.byproductLines.length,
          0,
        ),
      0,
    ) + 1

  const savedFrom = (
    input: OrderDraft,
    id: string,
    previous?: OrderSavedDraft,
  ): OrderSavedDraft => {
    const oldItems = new Map(
      previous?.items.map((item) => [String(item.id), item]) ?? [],
    )
    const seenItems = new Set<string>()
    const items = input.items.map((item) => {
      if (item.id != null) {
        if (!oldItems.has(item.id)) {
          throw new Error(`条目 ${item.id} 不属于订单 ${id}`)
        }
        if (seenItems.has(item.id)) throw new Error(`条目 ${item.id} 重复`)
        seenItems.add(item.id)
      }
      const itemId = item.id ?? `${side}-order-item-${nextItem++}`
      const previousItem = oldItems.get(itemId)
      const buildSavedLines = (
        kind: 'issue' | 'byproduct',
        lines: OrderDraftLine[],
      ): Row[] => {
        if (side === 'sales' && lines.length > 0) {
          throw new Error('销售订单不支持委外配置')
        }
        if (
          side === 'purchase' &&
          !Boolean(input.isOutsourced) &&
          lines.length > 0
        ) {
          throw new Error('仅委外订单可维护委外配置')
        }
        const oldLines = new Set(
          (kind === 'issue'
            ? previousItem?.issueLines
            : previousItem?.byproductLines
          )?.map((line) => String(line.id)) ?? [],
        )
        const seenLines = new Set<string>()
        return lines.map((line) => {
          if (line.id != null) {
            if (!oldLines.has(line.id)) {
              throw new Error(`${kind} 清单行 ${line.id} 不属于订单条目 ${itemId}`)
            }
            if (seenLines.has(line.id)) {
              throw new Error(`${kind} 清单行 ${line.id} 重复`)
            }
            seenLines.add(line.id)
          }
          return {
            ...line,
            id: line.id ?? `${side}-order-${kind}-${nextLine++}`,
            orderItemId: itemId,
            ...(kind === 'issue' ? { issuedQty: '0' } : {}),
          }
        })
      }
      return {
        ...item,
        id: itemId,
        orderId: id,
        issueLines: buildSavedLines('issue', item.issueLines),
        byproductLines: buildSavedLines(
          'byproduct',
          item.byproductLines,
        ),
      } as Row & { issueLines: Row[]; byproductLines: Row[] }
    })
    return {
      ...(previous ?? {}),
      ...input,
      id,
      status: previous?.status ?? 'DRAFT',
      items,
    } as OrderSavedDraft
  }

  return {
    async loadDraft(id) {
      const draft = drafts.get(id)
      if (!draft) throw new Error(`订单 ${id} 不存在`)
      return clone(draft)
    },
    async createDraft(input) {
      if (
        input.items.some(
          (item) =>
            item.id != null ||
            item.issueLines.some((line) => line.id != null) ||
            item.byproductLines.some((line) => line.id != null),
        )
      ) {
        throw new Error('新订单草稿不能包含持久化子记录 id')
      }
      const id = `${side}-order-${nextHead++}`
      const saved = savedFrom(input, id)
      drafts.set(id, clone(saved))
      return clone(saved)
    },
    async replaceDraft(id, input) {
      const previous = drafts.get(id)
      if (!previous) throw new Error(`订单 ${id} 不存在`)
      if (input.companyId !== previous.companyId) {
        throw new Error('订单创建后不可修改公司')
      }
      const saved = savedFrom(input, id, previous)
      drafts.set(id, clone(saved))
      return clone(saved)
    },
  }
}
