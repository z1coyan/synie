import { createFileRoute } from '@tanstack/react-router'
import { formatAmount } from '~/lib/amount'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { RECONCILIATION_DOC_STATUS_ENUM_COLORS } from '~/lib/doc-status'
import { useAuditDoc } from '../../scm/-audit-doc'
import {
  reconciliationAuditConfig,
  reconciliationConfirmConfig,
  useReconciliationDrawer,
} from './-reconciliation-drawer'

export const Route = createFileRoute('/_app/sales/reconciliations/')({
  component: ReconciliationsPage,
})

const GRID_OVERRIDES = {
  // 卡片:单号标题、客户副标题、状态/本币合计/类型摘要
  companyId: { mobileRole: 'hide' },
  reconciliationNo: { mobileRole: 'title' },
  partyId: { mobileRole: 'subtitle' },
  reconciliationType: { label: '对账类型', mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: RECONCILIATION_DOC_STATUS_ENUM_COLORS,
  },
  grossTotal: {
    label: '原币合计',
    render: (v: unknown) => formatAmount(v),
  },
  baseGrossTotal: {
    label: '本币合计',
    mobileRole: 'summary',
    render: (v: unknown) => formatAmount(v),
  },
  postingDate: { label: '过账日期' },
} satisfies Record<string, ColumnOverride>

// 列表只保留扫单常用列:对手类型由 partyId 多态展示,不单列;科目/备注进抽屉
const GRID_COLUMNS = [
  'companyId',
  'reconciliationNo',
  'reconciliationType',
  'partyId',
  'status',
  'grossTotal',
  'baseGrossTotal',
  'postingDate',
]

// 行操作按状态+类型出:草稿(编辑/删除/客户确认[常规]/结单[赠送样品])、客户已确认(撤回确认)、
// 已结单赠送样品单(作废;常规单已结单无独立作废入口,纠错走发票侧)
const ACTION_VISIBLE = {
  confirm: (row: Row) =>
    row.status === 'DRAFT' && row.reconciliationType === 'REGULAR',
  unconfirm: (row: Row) => row.status === 'CONFIRMED',
  audit: (row: Row) =>
    row.status === 'DRAFT' && row.reconciliationType === 'GIFT_SAMPLE',
  void: (row: Row) =>
    row.status === 'CLOSED' && row.reconciliationType === 'GIFT_SAMPLE',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function ReconciliationsPage() {
  const openDrawer = useReconciliationDrawer()
  // 客户确认(常规)与结单审核(赠送/样品)都走「列出全部条目核对」的确认弹窗
  const { requestAudit: requestConfirm, auditDialog: confirmDialog } =
    useAuditDoc(reconciliationConfirmConfig)
  const { requestAudit, auditDialog } = useAuditDoc(reconciliationAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="salReconciliations"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'reconciliationNo', direction: 'descending' }}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) =>
          openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)
        }
        // 确认/结单改走条目核对弹窗;撤回确认/作废走默认通用确认框
        actionHandlers={{
          confirm: (rows, ctx) =>
            requestConfirm(String(rows[0].id), ctx.refetch),
          audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch),
        }}
        actionVisible={ACTION_VISIBLE}
      />
      {confirmDialog}
      {auditDialog}
    </>
  )
}
