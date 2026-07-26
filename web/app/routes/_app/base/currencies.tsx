import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { currencyClient } from '~/lib/resources/currencies'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/currencies')({
  component: CurrenciesPage,
})

function CurrenciesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">货币管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        交易与账务使用的货币主数据。停用后不可再选作新单据/公司本币；历史引用不受影响。被公司引用为本币的不可停用。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="basCurrencies"
          client={currencyClient}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={statusToggleActions({
            field: 'active',
            update: currencyClient.update.bind(currencyClient),
            rowLabel: (row) => String(row.name ?? row.isoCode ?? ''),
            onDone: () => queryClient.invalidateQueries({ queryKey: ['gridRows', currencyClient.id, 'basCurrencies'] }),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource="basCurrencies"
        client={currencyClient}
        label="货币"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        // 启用是状态不是表单字段(规范):新建默认启用,启停走列表行动作
        exclude={['active']}
        fields={{
          name: { required: true, placeholder: '如 人民币' },
          // 后端 update 不收 iso_code,创建后不可改
          isoCode: { required: true, edit: 'createOnly', placeholder: '三位大写字母,如 CNY' },
          symbol: { placeholder: '如 ¥' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          const saved = mode === 'create'
            ? await currencyClient.create(values)
            : await currencyClient.update(drawer!.row!.id, values)
          toast.success(mode === 'create' ? '货币已创建' : '货币已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', currencyClient.id, 'basCurrencies'] })
          return saved.id
        }}
      />
    </>
  )
}
