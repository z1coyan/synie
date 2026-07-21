import { createFileRoute } from '@tanstack/react-router'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useAuditDoc } from '../-audit-doc'
import { purchaseOrderAuditConfig, useOrderDrawer } from './-order-drawer'

export const Route = createFileRoute('/_app/scm/purchase/orders')({
  component: PurchaseOrdersTab,
})

// 状态胶囊配色:草稿灰、已审核绿、已关闭黄、已作废红
// 双币总额混合列表全列展示(本币单两套同值);汇率不进表格,抽屉里看
const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  // 订单分型:常规灰、零星蓝;枚举筛选由 meta(filterable)自动带出
  orderType: { label: '类型', enumColors: { REGULAR: 'default', SPOT: 'accent' } },
  currencyId: { label: '币种' },
  grossTotal: { label: '原币含税总额', render: (v: unknown) => formatAmount(v) },
  baseGrossTotal: { label: '本币含税总额', render: (v: unknown) => formatAmount(v) },
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', CLOSED: 'warning', VOIDED: 'danger' } },
} satisfies Record<string, ColumnOverride>

// 常用列白名单:时间戳/审核人/录入人不进表格(兼当 exclude)
const GRID_COLUMNS = [
  'companyId',
  'orderNo',
  'orderDate',
  'orderType',
  'partyType',
  'partyId',
  'currencyId',
  'grossTotal',
  'baseGrossTotal',
  'status',
]

// 状态机动作显隐:审核/删除仅草稿,关闭/作废仅已审核(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  close: (row: Row) => row.status === 'AUDITED',
  void: (row: Row) => row.status === 'AUDITED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

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
