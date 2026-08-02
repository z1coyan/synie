import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCustomerCreate,
  decodeCustomerUpdate,
  useCatalogBasicForm,
  requireWriter,
} from '~/lib/resources/catalog'
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
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '客户')

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
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        exclude={formProps.exclude}
        fields={formProps.fields}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const input = decodeCustomerCreate(values)
            const saved = await requireWriter(binding, 'create', '客户')({ ...input })
            toast.success('客户已创建')
            invalidate()
            return saved.id as string
          }
          const input = decodeCustomerUpdate(values)
          const saved = await requireWriter(binding, 'update', '客户')(String(drawer!.recordId), {
            ...input,
          })
          toast.success('客户已更新')
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
