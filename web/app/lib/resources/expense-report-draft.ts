import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { AggregateDraftAdapter } from './catalog/types'

export type ExpenseReportDraftItem = {
  id?: string
  idx: unknown
  kind: unknown
  invoiceId: unknown
  summary: unknown
  amount: unknown
  expenseAccountId: unknown
  remarks: unknown
}

export type ExpenseReportDraft = Record<string, unknown> & {
  items: ExpenseReportDraftItem[]
}

export type ExpenseReportSavedDraft = Row & {
  items: Row[]
}

/**
 * 报销行的两个业务槽位互斥：挂票行只提交发票，无票行只提交摘要、金额与费用科目。
 * UI 为金额核对保留的发票快照不进入 wire input；存量行保留 id 供聚合替换原位更新。
 */
export function itemInput(row: Row): ExpenseReportDraftItem {
  const invoiced = row.kind === 'INVOICED'
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: row.idx,
    kind: row.kind,
    invoiceId: invoiced ? row.invoiceId : null,
    summary: invoiced ? null : (row.summary ?? null),
    amount: invoiced ? null : (row.amount ?? null),
    expenseAccountId: invoiced ? null : (row.expenseAccountId ?? null),
    remarks: row.remarks ?? null,
  }
}

/** 头与全部报销行合成一个权威聚合草稿。 */
export function buildExpenseReportDraft(
  values: Record<string, unknown>,
  rows: Row[],
): ExpenseReportDraft {
  return {
    ...values,
    items: rows.map(itemInput),
  }
}

const unavailable = async (): Promise<never> => {
  throw new Error('报销单草稿尚未由 Convex 应用壳装配')
}

/** 模块级稳定对象；应用壳会原地换成真实 Convex draft gateway。 */
export const expenseReportDraftAdapter: AggregateDraftAdapter<
  ExpenseReportDraft,
  ExpenseReportSavedDraft
> = {
  loadDraft: unavailable,
  createDraft: unavailable,
  replaceDraft: unavailable,
}
