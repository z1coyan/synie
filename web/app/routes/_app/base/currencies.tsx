import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCurrencyCreate,
  decodeCurrencyUpdate,
  useCatalogBasicForm,
} from '~/lib/resources/catalog'
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
              if (!binding.writer || !('update' in binding.writer) || !binding.writer.update) {
                throw new Error('币种不支持 update')
              }
              return binding.writer.update(id, input)
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
          if (!binding.writer) throw new Error('币种不支持写入')
          if (mode === 'create') {
            if (!('create' in binding.writer) || !binding.writer.create) {
              throw new Error('币种不支持 create')
            }
            const input = decodeCurrencyCreate(values)
            const saved = await binding.writer.create({ ...input })
            toast.success('货币已创建')
            invalidate()
            return saved.id as string
          }
          if (!('update' in binding.writer) || !binding.writer.update) {
            throw new Error('币种不支持 update')
          }
          const input = decodeCurrencyUpdate(values)
          const saved = await binding.writer.update(String(drawer!.row!.id), { ...input })
          toast.success('货币已更新')
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
