import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/work-orders')({
  component: WorkOrdersPage,
})

const CREATE_WO = `
  mutation ($input: CreateMfgWorkOrderInput!) {
    createMfgWorkOrder(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_WO = `
  mutation ($id: ID!, $input: UpdateMfgWorkOrderInput!) {
    updateMfgWorkOrder(id: $id, input: $input) { result { id } errors { message } }
  }
`

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

function WorkOrdersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产工单</h1>
      <p className="mt-2 text-sm text-ink-500">
        从已确认自制需求行生成；一需求行一张未作废工单；未完成数量 = 工单数量 − 累计生产入库。无客户字段。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgWorkOrders"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgWorkOrders"
        {...drawerConfig('mfgWorkOrders')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createMfgWorkOrder: { errors: { message: string }[] | null }
            }>(CREATE_WO, {
              input: {
                demandItemId: values.demandItemId,
                workOrderNo: values.workOrderNo || null,
              },
            })
            if (data.createMfgWorkOrder.errors?.length) {
              throw new Error(data.createMfgWorkOrder.errors.map((e) => e.message).join('; '))
            }
            toast.success('生产工单已生成')
          } else {
            const data = await gqlFetch<{
              updateMfgWorkOrder: { errors: { message: string }[] | null }
            }>(UPDATE_WO, {
              id: drawer!.row!.id,
              input: { workOrderNo: values.workOrderNo },
            })
            if (data.updateMfgWorkOrder.errors?.length) {
              throw new Error(data.updateMfgWorkOrder.errors.map((e) => e.message).join('; '))
            }
            toast.success('生产工单已更新')
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgWorkOrders'] })
        }}
      />
    </>
  )
}
