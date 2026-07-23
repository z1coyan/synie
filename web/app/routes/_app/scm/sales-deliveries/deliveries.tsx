import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useTemplatePrint } from '~/components/synie-print/TemplatePrintDialog'
import { useAuditDoc } from '../-audit-doc'
import { deliveryAuditConfig, useDeliveryDrawer } from './-delivery-drawer'

export const Route = createFileRoute('/_app/scm/sales-deliveries/deliveries')({
  component: DeliveriesTab,
})

const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
} satisfies Record<string, ColumnOverride>

const GRID_COLUMNS = [
  'companyId',
  'deliveryNo',
  'deliveryDate',
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

function DeliveriesTab() {
  const openDrawer = useDeliveryDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(deliveryAuditConfig)
  const { start: startPrint, dialog: printDialog } = useTemplatePrint('sales.delivery')

  return (
    <>
      <SynieDataGrid
        resource="salDeliveries"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'deliveryDate', direction: 'descending' }}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
        onPrint={(rows) => void startPrint('print', rows)}
        // 审核改走「列出全部条目核对」的确认弹窗(与条目页「审核整单」同一套)
        actionHandlers={{ audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch) }}
        actionVisible={ACTION_VISIBLE}
        rowActions={[
          {
            key: 'exportExcel',
            label: '导出 Excel',
            capability: 'export',
            onAction: (row) => void startPrint('export', [row]),
          },
        ]}
        bulkActions={[
          {
            key: 'batchExportExcel',
            label: '批量导出 Excel',
            capability: 'export',
            onAction: (rows) => void startPrint('export', rows),
          },
        ]}
      />
      {auditDialog}
      {printDialog}
    </>
  )
}
