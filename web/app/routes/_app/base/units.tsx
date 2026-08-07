import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeUnitCreate,
  decodeUnitUpdate,
  useCatalogBasicForm,
  requireWriter,
  resourceLabel,
} from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

const RESOURCE = 'basUnits'

export const Route = createFileRoute('/_app/base/units')({
  // 首屏列表预取：与 DataGrid 默认 page/filters 对齐，组件 useQuery 同 key 无缝衔接
  // SSR 内 ensureDefaultGridPage 直接跳过（鉴权数据不在本轮 SSR 发出）
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: UnitsPage,
})

function UnitsPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
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
            const input = decodeUnitCreate(values)
            const saved = await requireWriter(binding, 'create')({ ...input })
            toast.success(`${resourceLabel('basUnits')}已创建`)
            invalidate()
            return saved.id as string
          }
          const input = decodeUnitUpdate(values)
          const saved = await requireWriter(binding, 'update')(String(drawer!.recordId), {
            ...input,
          })
          toast.success(`${resourceLabel('basUnits')}已更新`)
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
