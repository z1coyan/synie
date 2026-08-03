import { createFileRoute } from '@tanstack/react-router'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import {
  ORDER_DOC_ACTION_VISIBLE,
  ORDER_DOC_STATUS_ENUM_COLORS,
  PURCHASE_ORDER_TYPE_ENUM_COLORS,
} from '~/lib/doc-status'
import { useAuditDoc } from '../../scm/-audit-doc'
import { purchaseOrderAuditConfig, useOrderDrawer } from './-order-drawer'

export const Route = createFileRoute('/_app/purchase/orders/orders')({
  component: PurchaseOrdersTab,
})

// 状态胶囊配色:草稿灰、已审核绿、已关闭黄、已作废红
// 双币总额混合列表全列展示(本币单两套同值);汇率不进表格,抽屉里看
const GRID_OVERRIDES = {
  // 卡片:单号标题、供应商副标题、日期/状态/本币总额摘要
  companyId: { mobileRole: 'hide' },
  orderNo: { mobileRole: 'title' },
  partyId: { mobileRole: 'subtitle' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  orderDate: { mobileRole: 'summary' },
  // 订单分型:常规灰、零星蓝;枚举筛选由 meta(filterable)自动带出
  orderType: { label: '类型', enumColors: PURCHASE_ORDER_TYPE_ENUM_COLORS },
  // 委外标记:布尔列,勾选即委外订单(条目=成品、单价=加工费)
  isOutsourced: { label: '委外' },
  currencyId: { label: '币种' },
  grossTotal: { label: '原币含税总额', render: (v: unknown) => formatAmount(v) },
  baseGrossTotal: {
    label: '本币含税总额',
    mobileRole: 'summary',
    render: (v: unknown) => formatAmount(v),
  },
  status: {
    mobileRole: 'summary',
    enumColors: ORDER_DOC_STATUS_ENUM_COLORS,
  },
} satisfies Record<string, ColumnOverride>

// 常用列白名单:时间戳/审核人/录入人不进表格(兼当 exclude)
const GRID_COLUMNS = [
  'companyId',
  'orderNo',
  'orderDate',
  'orderType',
  'isOutsourced',
  'partyType',
  'partyId',
  'currencyId',
  'grossTotal',
  'baseGrossTotal',
  'status',
]

// 状态机动作显隐:审核/删除仅草稿,关闭/作废仅已审核(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = ORDER_DOC_ACTION_VISIBLE

function PurchaseOrdersTab() {
  const openDrawer = useOrderDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(purchaseOrderAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purOrders"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
        // 审核改走「列出全部条目核对」的确认弹窗(与条目页「审核整单」同一套)
        actionHandlers={{ audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch) }}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
