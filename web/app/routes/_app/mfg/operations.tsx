import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { operationClient } from '~/lib/resources/manufacturing'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/operations')({
  component: OperationsPage,
})

// 列白名单:时间戳不进表格
const GRID_COLUMNS = ['code', 'name', 'note']

function OperationsPage() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">工序</h1>
      <p className="mt-2 text-sm text-ink-500">
        全局共享的工序主数据,BOM 工艺路线与工艺模板按序引用;被引用后不可删除。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgOperations"
          client={operationClient}
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgOperations"
        client={operationClient}
        {...drawerConfig('mfgOperations')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await operationClient.create(values)
          } else {
            await operationClient.update(drawer!.row!.id, values)
          }
          toast.success(mode === 'create' ? '工序已创建' : '工序已更新')
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgOperations'],
          })
        }}
      />
    </>
  )
}
