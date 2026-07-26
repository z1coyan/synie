import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { supplierClient } from '~/lib/resources/suppliers'

export const Route = createFileRoute('/_app/scm/suppliers')({
  component: SuppliersPage,
})

function SuppliersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">供应商管理</h1>
      <p className="mt-2 text-sm text-ink-500">采购往来的供应商主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="purSuppliers"
          client={supplierClient}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="purSuppliers"
        client={supplierClient}
        label="供应商"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, placeholder: '如 S0001' },
          name: { required: true, placeholder: '供应商全称' },
          shortName: { placeholder: '如 富士康' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          const saved =
            mode === 'create'
              ? await supplierClient.create(values)
              : await supplierClient.update(drawer!.row!.id, values)
          toast.success(mode === 'create' ? '供应商已创建' : '供应商已更新')
          queryClient.invalidateQueries({
            queryKey: ['gridRows', supplierClient.id, 'purSuppliers'],
          })
          return saved.id
        }}
      />
    </>
  )
}
