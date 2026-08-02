import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCompanyCreate,
  decodeCompanyUpdate,
  useCatalogBasicForm,
  requireWriter,
} from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

export const Route = createFileRoute('/_app/system/companies')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: CompaniesPage,
})

const RESOURCE = 'basCompanies'

function CompaniesPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
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
            const input = decodeCompanyCreate(values)
            await requireWriter(binding, 'create', '公司')({ ...input })
            toast.success('公司已创建,并初始化 3 个默认仓库')
            invalidate()
            return
          }
          await requireWriter(binding, 'update', '公司')(String(drawer!.recordId), {
            ...decodeCompanyUpdate(values),
          })
          toast.success('公司已更新')
          invalidate()
        }}
      />
    </>
  )
}
