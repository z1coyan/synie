import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeSupplierCreate,
  decodeSupplierUpdate,
  useCatalogBasicForm,
} from '~/lib/resources/catalog'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/suppliers')({
  component: SuppliersPage,
})

// 卡片:名称标题、编号副标题、简称摘要
const GRID_OVERRIDES = {
  name: { mobileRole: 'title' },
  code: { mobileRole: 'subtitle' },
  shortName: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

const RESOURCE = 'purSuppliers'

function SuppliersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const { binding, client, formProps } = useCatalogBasicForm(RESOURCE, '供应商')

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['gridRows', client.id, RESOURCE] })

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">供应商管理</h1>
      <p className="mt-2 text-sm text-ink-500">采购往来的供应商主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          client={client}
          overrides={GRID_OVERRIDES}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        client={client}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={formProps.exclude}
        fields={formProps.fields}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (!binding.writer) throw new Error('供应商不支持写入')
          if (mode === 'create') {
            if (!('create' in binding.writer) || !binding.writer.create) {
              throw new Error('供应商不支持 create')
            }
            const input = decodeSupplierCreate(values)
            const saved = await binding.writer.create({ ...input })
            toast.success('供应商已创建')
            invalidate()
            return saved.id as string
          }
          if (!('update' in binding.writer) || !binding.writer.update) {
            throw new Error('供应商不支持 update')
          }
          const input = decodeSupplierUpdate(values)
          const saved = await binding.writer.update(String(drawer!.row!.id), { ...input })
          toast.success('供应商已更新')
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
