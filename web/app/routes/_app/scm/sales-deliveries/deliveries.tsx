import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useDeliveryDrawer } from './-delivery-drawer'

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

  return (
    <SynieDataGrid
      resource="salDeliveries"
      columns={GRID_COLUMNS}
      overrides={GRID_OVERRIDES}
      defaultSort={{ column: 'deliveryDate', direction: 'descending' }}
      onView={(row) => openDrawer('view', row)}
      onCreate={() => openDrawer('create', null)}
      onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
      actionVisible={ACTION_VISIBLE}
    />
  )
}
