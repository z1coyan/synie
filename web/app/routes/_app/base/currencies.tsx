import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCurrencyCreate,
  decodeCurrencyUpdate,
  useCatalogBasicForm,
  requireWriter,
  resourceLabel,
} from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

const RESOURCE = 'basCurrencies'

export const Route = createFileRoute('/_app/base/currencies')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: CurrenciesPage,
})

function CurrenciesPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '货币')

  const invalidate = () =>
    binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-xl">货币管理</h1>
      <p className="mt-1 text-xs text-ink-500">
        交易与账务使用的货币主数据。停用后不可再选作新单据/公司本币；历史引用不受影响。被公司引用为本币的不可停用。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          rowActions={statusToggleActions({
            field: 'active',
            update: (id, input) => {
              return requireWriter(binding, 'update', '币种')(id, input)
            },
            rowLabel: (row) => String(row.name ?? row.isoCode ?? ''),
            onDone: invalidate,
          })}
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
            const input = decodeCurrencyCreate(values)
            const saved = await requireWriter(binding, 'create', '币种')({ ...input })
            toast.success(`${resourceLabel('basCurrencies')}已创建`)
            invalidate()
            return saved.id as string
          }
          const input = decodeCurrencyUpdate(values)
          const saved = await requireWriter(binding, 'update', '币种')(String(drawer!.recordId), {
            ...input,
          })
          toast.success(`${resourceLabel('basCurrencies')}已更新`)
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
