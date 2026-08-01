import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCompanyCreate,
  decodeCompanyUpdate,
  useCatalogBasicForm,
  requireWriter,} from '~/lib/resources/catalog'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/companies')({
  component: CompaniesPage,
})

const RESOURCE = 'basCompanies'

function CompaniesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '公司')

  const invalidate = () =>
    binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">公司管理</h1>
      <p className="mt-2 text-sm text-ink-500">多公司主数据与集团层级。</p>

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
            const input = decodeCompanyCreate(values)
            await requireWriter(binding, 'create', '公司')({ ...input })
            toast.success('公司已创建,并初始化 3 个默认仓库')
            invalidate()
            return
          }
          await requireWriter(binding, 'update', '公司')(String(drawer!.row!.id), {
            ...decodeCompanyUpdate(values),
          })
          toast.success('公司已更新')
          invalidate()
        }}
      />
    </>
  )
}
