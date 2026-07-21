import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useAuditDoc } from '../-audit-doc'
import { receiptAuditConfig, useReceiptDrawer } from './-receipt-drawer'

export const Route = createFileRoute('/_app/scm/purchase-receipts/receipts')({
  component: ReceiptsTab,
})

const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
} satisfies Record<string, ColumnOverride>

const GRID_COLUMNS = [
  'companyId',
  'receiptNo',
  'receiptDate',
  'partyType',
  'partyId',
  'status',
  'postingDate',
]

const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function ReceiptsTab() {
  const openDrawer = useReceiptDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(receiptAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purReceipts"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'receiptDate', direction: 'descending' }}
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
