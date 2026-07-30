import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { workOrderClient } from '~/lib/resources/manufacturing'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/work-orders')({
  component: WorkOrdersPage,
})

const GRID_COLUMNS = [
  'workOrderNo',
  'materialCode',
  'materialName',
  'qty',
  'receivedBaseQty',
  'remainingBaseQty',
  'needDate',
  'status',
  'demandId',
  'companyId',
]

// 卡片:物料标题、工单号副标题、状态/未完成量/需求日摘要(车间跟单)
const GRID_OVERRIDES = {
  materialCode: { mobileRole: 'hide' },
  companyId: { mobileRole: 'hide' },
  materialName: {
    mobileRole: 'title',
    render: (_v: unknown, row: Row) => {
      const code = row.materialCode != null ? String(row.materialCode) : ''
      const name = row.materialName != null ? String(row.materialName) : ''
      const text = [code, name].filter(Boolean).join(' ')
      return text || undefined
    },
  },
  workOrderNo: { mobileRole: 'subtitle' },
  status: { mobileRole: 'summary' },
  remainingBaseQty: { mobileRole: 'summary' },
  needDate: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

function WorkOrdersPage() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产工单</h1>
      <p className="mt-2 text-sm text-ink-500">
        从已确认自制需求行生成；一需求行一张未作废工单；未完成数量 = 工单数量 −
        累计生产入库。无客户字段。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgWorkOrders"
          client={workOrderClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgWorkOrders"
        client={workOrderClient}
        {...drawerConfig('mfgWorkOrders')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await workOrderClient.create({
              demandItemId: values.demandItemId,
              workOrderNo: values.workOrderNo || null,
            })
            toast.success('生产工单已生成')
          } else {
            await workOrderClient.update(drawer!.row!.id, {
              workOrderNo: values.workOrderNo,
            })
            toast.success('生产工单已更新')
          }
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgWorkOrders'],
          })
        }}
      />
    </>
  )
}
