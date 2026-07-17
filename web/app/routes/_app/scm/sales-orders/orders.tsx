import { createFileRoute } from '@tanstack/react-router'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useOrderDrawer } from './-order-drawer'

export const Route = createFileRoute('/_app/scm/sales-orders/orders')({
  component: SalesOrdersTab,
})

// 状态胶囊配色:草稿灰、已审核绿、已关闭黄、已作废红
const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  grossTotal: { label: '含税总额', render: (v: unknown) => formatAmount(v) },
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', CLOSED: 'warning', VOIDED: 'danger' } },
} satisfies Record<string, ColumnOverride>

// 常用列白名单:时间戳/审核人/录入人不进表格(兼当 exclude)
const GRID_COLUMNS = ['companyId', 'orderNo', 'orderDate', 'partyType', 'partyId', 'grossTotal', 'status']

// 状态机动作显隐:审核/删除仅草稿,关闭/作废仅已审核(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  close: (row: Row) => row.status === 'AUDITED',
  void: (row: Row) => row.status === 'AUDITED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function SalesOrdersTab() {
  const openDrawer = useOrderDrawer()

  return (
    <SynieDataGrid
      resource="salOrders"
      columns={GRID_COLUMNS}
      overrides={GRID_OVERRIDES}
      onView={(row) => openDrawer('view', row)}
      onCreate={() => openDrawer('create', null)}
      onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
      actionVisible={ACTION_VISIBLE}
    />
  )
}
