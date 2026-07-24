import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useAuditDoc } from '../-audit-doc'
import { issueAuditConfig, useIssueDrawer } from './-issue-drawer'

export const Route = createFileRoute('/_app/scm/outsourced-issues/issues')({
  component: IssuesTab,
})

const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
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

const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

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
