import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import {
  AUDIT_DOC_ACTION_VISIBLE,
  AUDIT_DOC_STATUS_ENUM_COLORS,
} from '~/lib/doc-status'
import { useAuditDoc } from '../../scm/-audit-doc'
import { returnAuditConfig, useReturnDrawer } from './-return-drawer'

export const Route = createFileRoute('/_app/purchase/returns/returns')({
  component: PurReturnsTab,
})

const GRID_OVERRIDES = {
  // 卡片:单号标题、客户副标题、日期/状态摘要
  companyId: { mobileRole: 'hide' },
  returnNo: { mobileRole: 'title' },
  partyId: { mobileRole: 'subtitle' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  returnDate: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
} satisfies Record<string, ColumnOverride>

const GRID_COLUMNS = [
  'companyId',
  'returnNo',
  'returnDate',
  'partyType',
  'partyId',
  'status',
  'postingDate',
]

const ACTION_VISIBLE = AUDIT_DOC_ACTION_VISIBLE

function PurReturnsTab() {
  const openDrawer = useReturnDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(returnAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purReturns"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'returnDate', direction: 'descending' }}
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
