import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'

type AggregateRecord = Record<string, unknown>

function aggregateRecord(value: unknown, label: string): AggregateRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}草稿响应不是对象`)
  }
  return value as AggregateRecord
}

/**
 * AggregateDraftAdapter.loadDraft 的集合是权威完整子树；响应缺集合或含无 id 行时
 * 必须 fail-closed，不能把暂态空数组提交成“删除全部”。
 */
export function aggregateDraftRows(
  value: unknown,
  collection: string,
  label: string,
): Row[] {
  const draft = aggregateRecord(value, label)
  const rows = draft[collection]
  if (!Array.isArray(rows)) throw new Error(`${label}草稿响应缺少完整 ${collection} 集合`)
  return rows.map((row, index) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${label}${collection}第 ${index + 1} 行不是对象`)
    }
    const id = (row as AggregateRecord).id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${label}${collection}第 ${index + 1} 行缺少 id`)
    }
    return row as Row
  })
}

/** create/replace 均以 mutation 返回的权威 id 驱动“保存并审核”。 */
export function aggregateDraftId(value: unknown, label: string): string {
  const id = aggregateRecord(value, label).id
  if (typeof id !== 'string' || id.trim() === '') throw new Error(`${label}草稿响应缺少 id`)
  return id
}

function persistedId(row: Row): { id?: string } {
  return isLocalRow(row) ? {} : { id: row.id }
}

/** 手工出入库与调拨共用的库存移动行草稿。 */
export function stockMovementDraftRow(row: Row): AggregateRecord {
  return {
    ...persistedId(row),
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    remark: row.remark ?? null,
  }
}

export function stockCountDraftRow(row: Row): AggregateRecord {
  return {
    ...persistedId(row),
    materialId: row.materialId,
    unitId: row.unitId,
    countedQuantity: row.countedQuantity ?? null,
    remark: row.remark ?? null,
  }
}

export function journalDraftLine(row: Row): AggregateRecord {
  return {
    ...persistedId(row),
    idx: row.idx,
    accountId: row.accountId,
    debit: row.debit,
    credit: row.credit,
    partyType: row.partyType ?? null,
    partyId: row.partyId ?? null,
    remarks: row.remarks ?? null,
  }
}
