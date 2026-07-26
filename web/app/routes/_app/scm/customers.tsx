import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { customerClient } from '~/lib/resources/customers'

export const Route = createFileRoute('/_app/scm/customers')({
  component: CustomersPage,
})

function CustomersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">客户管理</h1>
      <p className="mt-2 text-sm text-ink-500">销售往来的客户主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="salCustomers"
          client={customerClient}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="salCustomers"
        client={customerClient}
        label="客户"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, placeholder: '如 C0001' },
          name: { required: true, placeholder: '客户全称' },
          shortName: { placeholder: '如 华为' },
        }}
        extraContent={(mode, row) => (
          <SynieAttachmentPanel
            ownerType="sal_customer"
            ownerId={row?.id as string | undefined}
            readonly={mode === 'view'}
          />
        )}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          const saved =
            mode === 'create'
              ? await customerClient.create(values)
              : await customerClient.update(drawer!.row!.id, values)
          toast.success(mode === 'create' ? '客户已创建' : '客户已更新')
          queryClient.invalidateQueries({
            queryKey: ['gridRows', customerClient.id, 'salCustomers'],
          })
          return saved.id
        }}
      />
    </>
  )
}
