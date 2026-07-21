import { ProgressBar } from '@heroui/react'
import type { Row } from '~/components/synie-data-grid/types'

// 数量最多 4 位小数、去尾零(行单位换算回来的已收/发可能带长小数,如 1÷3 换算);
// 非法值原样字符串化,同 formatAmount 纪律
function fmtQty(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

export interface QtyProgressLabels {
  /** 已完成的动作名:采购「已收」/销售「已发」 */
  done: string
  /** 未完成的动作名:采购「未收」/销售「未发」 */
  remaining: string
}

/**
 * 订单条目「数量进度」合并单元格(采购已收/销售已发共用):数量、已收/发、未收/发并一列,
 * 进度条 + 「已收 X / 数量 · 未收 Y」两行展示。
 *
 * 口径:receivedQty/shippedQty 与 remainingBaseQty 是物料默认单位投影列,行 qty 是行单位;
 * 单元格按 baseQty/qty 换算比把已收/发折回行单位展示(无转换单位时两口径同值),
 * 进度百分比按默认单位算(比值与单位无关)。行数据由 extraFields 补取 qty/baseQty/doneField。
 */
export function QtyProgressCell({
  row,
  doneField,
  labels,
}: {
  row: Row
  doneField: 'receivedQty' | 'shippedQty'
  labels: QtyProgressLabels
}) {
  const qty = Number(row.qty)
  const base = Number(row.baseQty)
  const done = Number(row[doneField])
  if (!Number.isFinite(qty) || !Number.isFinite(base) || !Number.isFinite(done) || base <= 0) {
    return <span className="text-muted">—</span>
  }
  const pct = Math.min(100, Math.max(0, (done / base) * 100))
  const doneItem = (qty * done) / base
  const remainingItem = qty - doneItem
  return (
    <div className="flex w-44 flex-col gap-1 py-0.5">
      <div className="flex items-baseline justify-between gap-2 text-xs whitespace-nowrap">
        <span>
          {labels.done} {fmtQty(doneItem)} / {fmtQty(qty)}
        </span>
        <span className="text-muted">
          {labels.remaining} {fmtQty(remainingItem)}
        </span>
      </div>
      <ProgressBar value={pct} size="sm" color={pct >= 100 ? 'success' : 'accent'} aria-label="收发进度">
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
    </div>
  )
}
