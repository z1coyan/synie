/**
 * 承兑持有段重放纯核：把已审核交易序列投影为当前持有段。
 * IO（读交易 / 整删整建 holding）归 bill-service adapter。
 * 行为对齐 docs/业务模块/票据.md「库存重放」。
 */
import { decimal, toDecimalString } from '@synie/shared'
import { ApiError } from '~/platform/http/errors.ts'

/** 重放输入：仅已审核交易，调用方保证按 (occurredOn, auditedAt, id) 排序 */
export interface ReplayTx {
  id: string
  docNo: string | null
  /** DB 小写枚举：receive / endorse / settle / discount / reallocate */
  transactionType: string
  occurredOn: string
  subStart: number
  subEnd: number
  companyId: string
  bankAccountId: string
  toBankAccountId: string | null
}

export interface HoldingSegment {
  companyId: string
  bankAccountId: string
  start: number
  end: number
  acquiredOn: string
  sourceId: string
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

function conflict(message: string): ApiError {
  return new ApiError('conflict', message)
}

/**
 * 纯变换：按交易序列重放持有段。
 * - receive：段不得与任何现有持有段重叠（跨公司/账户）
 * - endorse/settle/discount：从本方公司+账户消耗段（可横跨多段、自动拆段）
 * - reallocate：先按本方账户消耗，再写入转入账户
 */
export function replaySegments(txs: readonly ReplayTx[]): HoldingSegment[] {
  let segments: HoldingSegment[] = []

  for (const row of txs) {
    const id = row.id
    const kind = row.transactionType
    const start = row.subStart
    const end = row.subEnd
    const companyId = row.companyId
    const bankAccountId = row.bankAccountId
    const occurred = row.occurredOn
    const label = row.docNo || id

    if (kind === 'receive') {
      for (const seg of segments) {
        if (overlaps(seg.start, seg.end, start, end)) {
          throw conflict(`承兑库存校验失败:交易 ${label} 接收段与现有持有段重叠`)
        }
      }
      segments.push({
        companyId,
        bankAccountId,
        start,
        end,
        acquiredOn: occurred,
        sourceId: id,
      })
      continue
    }

    const next: HoldingSegment[] = []
    let cursor = start
    segments = [...segments].sort((a, b) => a.start - b.start)
    for (const segment of segments) {
      if (
        segment.companyId !== companyId ||
        segment.bankAccountId !== bankAccountId ||
        !overlaps(segment.start, segment.end, start, end)
      ) {
        next.push(segment)
        continue
      }
      if (segment.start > cursor) {
        throw conflict(`承兑库存校验失败:交易 ${label} 段 ${cursor}-${segment.start - 1} 未持有`)
      }
      if (segment.start < start) {
        next.push({ ...segment, end: start - 1 })
      }
      if (segment.end >= cursor) cursor = segment.end + 1
      if (segment.end > end) {
        next.push({ ...segment, start: end + 1 })
      }
    }
    if (cursor <= end) {
      throw conflict(`承兑库存校验失败:交易 ${label} 段 ${cursor}-${end} 未持有`)
    }
    if (kind === 'reallocate') {
      if (!row.toBankAccountId) throw conflict('承兑库存校验失败:调拨缺少转入账户')
      next.push({
        companyId,
        bankAccountId: row.toBankAccountId,
        start,
        end,
        acquiredOn: occurred,
        sourceId: id,
      })
    }
    segments = next
  }

  return segments
}

/** 子票段金额（分 → 元）：闭区间长度 / 100，wire 形态对齐原 adapter */
export function segmentAmount(start: number, end: number): string {
  return toDecimalString(decimal(end - start + 1).div(100))
}

/** 闭区间持有分值合计（守恒断言用） */
export function totalSegmentCents(segments: readonly HoldingSegment[]): number {
  let sum = 0
  for (const s of segments) sum += s.end - s.start + 1
  return sum
}
