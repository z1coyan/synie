import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/currencies')({
  component: CurrenciesPage,
})

const CREATE_CURRENCY = `
  mutation ($input: CreateBasCurrencyInput!) {
    createBasCurrency(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_CURRENCY = `
  mutation ($id: ID!, $input: UpdateBasCurrencyInput!) {
    updateBasCurrency(id: $id, input: $input) { result { id } errors { message } }
  }
`

function CurrenciesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">货币管理</h1>
      <p className="mt-2 text-sm text-ink-500">交易与账务使用的货币主数据。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="basCurrencies"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="basCurrencies"
        label="货币"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          name: { required: true, placeholder: '如 人民币' },
          // 后端 update 不收 iso_code,创建后不可改
          isoCode: { required: true, edit: 'createOnly', placeholder: '三位大写字母,如 CNY' },
          symbol: { placeholder: '如 ¥' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createBasCurrency: { errors: { message: string }[] | null } }>(
              CREATE_CURRENCY,
              { input: values }
            )
            errors = data.createBasCurrency.errors
          } else {
            const data = await gqlFetch<{ updateBasCurrency: { errors: { message: string }[] | null } }>(
              UPDATE_CURRENCY,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateBasCurrency.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '货币已创建' : '货币已更新')
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
