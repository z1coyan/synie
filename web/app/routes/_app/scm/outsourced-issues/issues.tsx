import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import {
  AUDIT_DOC_ACTION_VISIBLE,
  AUDIT_DOC_STATUS_ENUM_COLORS,
} from '~/lib/doc-status'
import { useAuditDoc } from '../-audit-doc'
import { issueAuditConfig, useIssueDrawer } from './-issue-drawer'

export const Route = createFileRoute('/_app/scm/outsourced-issues/issues')({
  component: IssuesTab,
})

const GRID_OVERRIDES = {
  // 卡片:单号标题、协作方副标题、日期/状态摘要
  companyId: { mobileRole: 'hide' },
  issueNo: { mobileRole: 'title' },
  partyId: { mobileRole: 'subtitle' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  issueDate: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  fromWarehouseId: { label: '默认调出仓' },
  outsourcedWarehouseId: { label: '默认外协仓' },
} satisfies Record<string, ColumnOverride>

const GRID_COLUMNS = [
  'companyId',
  'issueNo',
  'issueDate',
  'partyType',
  'partyId',
  'status',
  'fromWarehouseId',
  'outsourcedWarehouseId',
]

const ACTION_VISIBLE = AUDIT_DOC_ACTION_VISIBLE

function IssuesTab() {
  const openDrawer = useIssueDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(issueAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purOutsourcedIssues"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'issueDate', direction: 'descending' }}
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
