import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCurrencyCreate,
  decodeCurrencyUpdate,
  useCatalogBasicForm,
  requireWriter,} from '~/lib/resources/catalog'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/currencies')({
  component: CurrenciesPage,
})

const RESOURCE = 'basCurrencies'

function CurrenciesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '货币')

  const invalidate = () =>
    binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">货币管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        交易与账务使用的货币主数据。停用后不可再选作新单据/公司本币；历史引用不受影响。被公司引用为本币的不可停用。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
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
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={formProps.exclude}
        fields={formProps.fields}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const input = decodeCurrencyCreate(values)
            const saved = await requireWriter(binding, 'create', '币种')({ ...input })
            toast.success('货币已创建')
            invalidate()
            return saved.id as string
          }
          const input = decodeCurrencyUpdate(values)
          const saved = await requireWriter(binding, 'update', '币种')(String(drawer!.row!.id), { ...input })
          toast.success('货币已更新')
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
