import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  createCustomerPresentation,
  submitCustomerForm,
} from '~/lib/resources/presentation'
import { resourceBindingFor, resourceClientFor } from '~/lib/resources/registry'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/customers')({
  component: CustomersPage,
})

// 卡片:名称标题、编号副标题、简称摘要(查客户首看叫什么)
const GRID_OVERRIDES = {
  name: { mobileRole: 'title' },
  code: { mobileRole: 'subtitle' },
  shortName: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

const RESOURCE = 'salCustomers'

function CustomersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  // Presentation Extension 由 binding 构造，不二次 resourceClientFor 取写能力
  const binding = resourceBindingFor(RESOURCE)
  const client = resourceClientFor(RESOURCE)
  const presentation = createCustomerPresentation(binding)

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ['gridRows', client.id, RESOURCE],
    })

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">客户管理</h1>
      <p className="mt-2 text-sm text-ink-500">销售往来的客户主数据,编号现阶段手工维护。</p>

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
        label={presentation.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={presentation.exclude}
        fields={presentation.fields}
        extraContent={presentation.extraContent}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          const id = await submitCustomerForm(
            presentation,
            values,
            mode,
            drawer?.row?.id != null ? String(drawer.row.id) : undefined,
          )
          toast.success(mode === 'create' ? '客户已创建' : '客户已更新')
          invalidate()
          return id
        }}
      />
    </>
  )
}
