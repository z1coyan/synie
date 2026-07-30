import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeUnitCreate,
  decodeUnitUpdate,
  useCatalogBasicForm,
} from '~/lib/resources/catalog'
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
  const { binding, client, formProps } = useCatalogBasicForm(RESOURCE, '单位')

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['gridRows', client.id, RESOURCE] })

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">单位管理</h1>
      <p className="mt-2 text-sm text-ink-500">计量单位主数据,每类型一个基准单位,其余按比例换算。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          client={client}
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
          if (!binding.writer) throw new Error('单位不支持写入')
          if (mode === 'create') {
            if (!('create' in binding.writer) || !binding.writer.create) {
              throw new Error('单位不支持 create')
            }
            const input = decodeUnitCreate(values)
            const saved = await binding.writer.create({ ...input })
            toast.success('单位已创建')
            invalidate()
            return saved.id as string
          }
          if (!('update' in binding.writer) || !binding.writer.update) {
            throw new Error('单位不支持 update')
          }
          const input = decodeUnitUpdate(values)
          const saved = await binding.writer.update(String(drawer!.row!.id), { ...input })
          toast.success('单位已更新')
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
