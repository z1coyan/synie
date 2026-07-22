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

export const Route = createFileRoute('/_app/mfg/operations')({
  component: OperationsPage,
})

const CREATE_OPERATION = `
  mutation ($input: CreateMfgOperationInput!) {
    createMfgOperation(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_OPERATION = `
  mutation ($id: ID!, $input: UpdateMfgOperationInput!) {
    updateMfgOperation(id: $id, input: $input) { result { id } errors { message } }
  }
`

// 列白名单:时间戳不进表格
const GRID_COLUMNS = ['code', 'name', 'note']

function OperationsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
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
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgOperations"
        {...drawerConfig('mfgOperations')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createMfgOperation: { errors: { message: string }[] | null } }>(
              CREATE_OPERATION,
              // 编号留空走自动取号:Ash 字符串类型把空串归为 nil,AutoNumber 见空取号(同订单号先例)
              { input: values }
            )
            errors = data.createMfgOperation.errors
          } else {
            const data = await gqlFetch<{ updateMfgOperation: { errors: { message: string }[] | null } }>(
              UPDATE_OPERATION,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateMfgOperation.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '工序已创建' : '工序已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgOperations'] })
        }}
      />
    </>
  )
}
