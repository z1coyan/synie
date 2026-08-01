import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeUnitCreate,
  decodeUnitUpdate,
  useCatalogBasicForm,
  requireWriter,} from '~/lib/resources/catalog'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/units')({
  component: UnitsPage,
})

const RESOURCE = 'basUnits'

function UnitsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '单位')

  const invalidate = () =>
    binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">单位管理</h1>
      <p className="mt-2 text-sm text-ink-500">计量单位主数据,每类型一个基准单位,其余按比例换算。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={formProps.exclude}
        fields={formProps.fields}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const input = decodeUnitCreate(values)
            const saved = await requireWriter(binding, 'create', '单位')({ ...input })
            toast.success('单位已创建')
            invalidate()
            return saved.id as string
          }
          const input = decodeUnitUpdate(values)
          const saved = await requireWriter(binding, 'update', '单位')(String(drawer!.row!.id), { ...input })
          toast.success('单位已更新')
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
