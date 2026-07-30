import { Popover, ProgressBar } from '@heroui/react'
import { formatQty } from '~/lib/amount'
import type { Row } from '~/components/synie-data-grid/types'

// 进度格空间窄，数量最多 4 位小数、去尾零(行单位换算回来的已入/未完成可能带长小数，如 1÷3 换算)
function fmtQty(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return formatQty(value, 4)
}

/**
 * 工单「数量进度」合并单元格：进度条 + 百分比单行，点击弹 Popover 看数量明细
 * (工单数量/已入库/未完成，折回行单位)。
 *
 * 口径：receivedBaseQty/remainingBaseQty 是物料默认单位投影列，行 qty 是需求行单位(unitName)；
 * 明细按 baseQty/qty 换算比折回行单位展示(无转换单位时两口径同值)，进度百分比按默认单位算
 * (比值与单位无关)。容差内超入：进度条截到 100%，百分比与未完成按实显示(未完成可为负)。
 * 行数据随 wire 全量返回(qty/baseQty/receivedBaseQty)，无需 extraFields。
 */
export function WorkOrderProgressCell({ row }: { row: Row }) {
  const qty = Number(row.qty)
  const base = Number(row.baseQty)
  const received = Number(row.receivedBaseQty)
  if (!Number.isFinite(qty) || !Number.isFinite(base) || !Number.isFinite(received) || base <= 0) {
    return <span className="text-muted">—</span>
  }
  const unit = row.unitName != null ? String(row.unitName) : ''
  const pct = (received / base) * 100
  const doneItem = (qty * received) / base
  const remainingItem = qty - doneItem
  const pctText = `${Math.round(pct)}%`
  return (
    // 卡片模式下触发器嵌在整卡点击区内：拦截 click 冒泡，防开 Popover 连带触发卡片开抽屉
    // (卡片的交互元素守卫只认原生 button/a/input，Popover.Trigger 是 role=button 的 div)
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <Popover>
        <Popover.Trigger
          aria-label="查看数量明细"
          className="flex w-40 cursor-pointer items-center gap-2 py-0.5"
        >
          <ProgressBar
            value={Math.min(100, Math.max(0, pct))}
            size="sm"
            color={pct >= 100 ? 'success' : 'accent'}
            aria-label="入库进度"
            className="min-w-0 flex-1"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <span className="shrink-0 text-xs tabular-nums text-muted">{pctText}</span>
        </Popover.Trigger>
        <Popover.Content className="w-64">
          <Popover.Dialog>
            <ul className="flex flex-col gap-1.5 text-[13px]">
              <li className="flex items-baseline justify-between gap-4">
                <span className="text-muted">工单数量</span>
                <span className="tabular-nums">
                  {fmtQty(qty)} {unit}
                </span>
              </li>
              <li className="flex items-baseline justify-between gap-4">
                <span className="text-muted">已入库</span>
                <span className="tabular-nums">
                  {fmtQty(doneItem)} {unit}（{pctText}）
                </span>
              </li>
              <li className="flex items-baseline justify-between gap-4">
                <span className="text-muted">未完成</span>
                <span className="tabular-nums">
                  {fmtQty(remainingItem)} {unit}
                </span>
              </li>
            </ul>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </span>
  )
}
