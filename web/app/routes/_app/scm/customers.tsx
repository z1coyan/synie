import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  createCustomerPresentation,
  submitCustomerForm,
} from '~/lib/resources/presentation'
import { resourceBindingFor } from '~/lib/resources/registry'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

export const Route = createFileRoute('/_app/scm/customers')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
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
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  // Presentation Extension 由 binding 构造，不二次解析写能力
  const binding = resourceBindingFor(RESOURCE)
  const presentation = createCustomerPresentation(binding)

  const invalidate = () =>
    binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">客户管理</h1>
      <p className="mt-2 text-sm text-ink-500">销售往来的客户主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          overrides={GRID_OVERRIDES}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={presentation.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        exclude={presentation.exclude}
        fields={presentation.fields}
        extraContent={presentation.extraContent}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          const id = await submitCustomerForm(
            presentation,
            values,
            mode,
            drawer?.recordId ?? undefined,
          )
          toast.success(mode === 'create' ? '客户已创建' : '客户已更新')
          invalidate()
          return id
        }}
      />
    </>
  )
}
