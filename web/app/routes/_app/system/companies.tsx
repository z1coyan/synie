import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCompanyCreate,
  decodeCompanyUpdate,
  useCatalogBasicForm,
} from '~/lib/resources/catalog'
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
  const { binding, client, formProps } = useCatalogBasicForm(RESOURCE, '公司')

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['gridRows', client.id, RESOURCE] })

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">公司管理</h1>
      <p className="mt-2 text-sm text-ink-500">多公司主数据与集团层级。</p>

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
          if (!binding.writer) throw new Error('公司不支持写入')
          if (mode === 'create') {
            if (!('create' in binding.writer) || !binding.writer.create) {
              throw new Error('公司不支持 create')
            }
            const input = decodeCompanyCreate(values)
            await binding.writer.create({ ...input })
            toast.success('公司已创建,并初始化 3 个默认仓库')
            invalidate()
            return
          }
          if (!('update' in binding.writer) || !binding.writer.update) {
            throw new Error('公司不支持 update')
          }
          await binding.writer.update(String(drawer!.row!.id), {
            ...decodeCompanyUpdate(values),
          })
          toast.success('公司已更新')
          invalidate()
        }}
      />
    </>
  )
}
