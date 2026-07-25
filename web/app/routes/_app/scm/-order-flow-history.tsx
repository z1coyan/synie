import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { formatQty } from '~/lib/amount'

// 「收发货历史」tab(销售/采购订单抽屉共用):该订单全部收发货单据行的统一只读视图。
// 后端 scm_order_flow_item 视图 UNION 采购入库/委外发料/委外入库/销售发货四类单据行,
// 未来退货等单据类型在后端视图扩展即自动出现;列全走视图内的行快照/头投影列,
// 不点 materialId 等触发嵌套授权的 fk;按 orderId 普通列过滤(不再走关系 filter)
const FLOW_COLUMNS = ['flowType', 'voucherNo', 'voucherDate', 'status', 'materialName', 'unitName', 'qty']
const FLOW_OVERRIDES = {
  flowType: {
    label: '单据类型',
    // 入库类绿、出库类蓝,未配的新类型(如退货)自动落 default 灰
    enumColors: {
      PURCHASE_RECEIPT: 'success',
      OUTSOURCED_RECEIPT: 'success',
      OUTSOURCED_ISSUE: 'accent',
      SALES_DELIVERY: 'accent',
    },
  },
  voucherNo: { label: '单据编号' },
  voucherDate: { label: '单据日期' },
  status: {
    label: '单据状态',
    enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' },
  },
  materialName: {
    label: '物料',
    render: (_v: unknown, r: Row) => {
      const code = r.materialCode != null ? String(r.materialCode) : ''
      const name = r.materialName != null ? String(r.materialName) : ''
      const title = [code, name].filter(Boolean).join(' ')
      if (!title && r.materialSpec == null && r.customerPartNo == null) return undefined
      const spec = r.materialSpec != null && r.materialSpec !== '' ? String(r.materialSpec) : null
      const cpn =
        r.customerPartNo != null && r.customerPartNo !== '' ? String(r.customerPartNo) : null
      return (
        <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
          {title ? <span className="truncate font-medium">{title}</span> : null}
          {spec ? (
            <span className="truncate text-xs text-muted" title={spec}>
              规格 {spec}
            </span>
          ) : null}
          {cpn ? (
            <span className="truncate text-xs text-muted" title={cpn}>
              客户料号 {cpn}
            </span>
          ) : null}
        </div>
      )
    },
  },
  unitName: { label: '单位' },
  qty: { label: '数量', render: (v: unknown) => formatQty(v) || undefined },
} satisfies Record<string, ColumnOverride>

/** 订单「收发货历史」表格:按单据日期倒序,只读 */
export function OrderFlowHistory({ orderId }: { orderId: string }) {
  return (
    <SynieDataGrid
      resource="scmOrderFlowItems"
      columns={FLOW_COLUMNS}
      overrides={FLOW_OVERRIDES}
      fixedFilter={{ orderId: { eq: orderId } }}
      defaultSort={{ column: 'voucherDate', direction: 'descending' }}
    />
  )
}
