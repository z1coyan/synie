import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/market-instruments')({
  component: MarketInstrumentsPage,
})

const CREATE = `
  mutation ($input: CreateBasMarketInstrumentInput!) {
    createBasMarketInstrument(input: $input) { result { id } errors { message } }
  }
`
const UPDATE = `
  mutation ($id: ID!, $input: UpdateBasMarketInstrumentInput!) {
    updateBasMarketInstrument(id: $id, input: $input) { result { id } errors { message } }
  }
`

const GRID_COLUMNS = [
  'code',
  'name',
  'sourceType',
  'defaultPriceKind',
  'currencyId',
  'unitId',
  'active',
  'fetchEnabled',
  'externalLastCode',
  'externalProductGroup',
  'note',
]

function MarketInstrumentsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">行情品种</h1>
      <p className="mt-2 text-sm text-ink-500">
        期货与现货参考价序列主数据（如沪铜、长江铜）。一条品种对应一条稳定价序列，全局共享。交易所序列可开启拉取并填写外部代码。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="basMarketInstruments"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="basMarketInstruments"
        label="行情品种"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '如 SHFE_CU', cols: 6 },
          name: { required: true, placeholder: '如 沪铜', cols: 6 },
          sourceType: { required: true, cols: 6 },
          defaultPriceKind: { required: true, cols: 6 },
          currencyId: { required: true, edit: 'createOnly', cols: 6 },
          unitId: { required: true, edit: 'createOnly', cols: 6 },
          active: { defaultValue: true },
          fetchEnabled: { defaultValue: false },
          externalLastCode: { placeholder: '主连如 CU0', cols: 6 },
          externalProductGroup: { placeholder: '上期所组如 cu', cols: 6 },
          note: { placeholder: '可选备注' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{
              createBasMarketInstrument: { errors: { message: string }[] | null }
            }>(CREATE, { input: values })
            errors = data.createBasMarketInstrument.errors
          } else {
            // 更新不收 code/币种/单位/来源类型
            const { code: _c, currencyId: _cu, unitId: _u, sourceType: _s, ...rest } = values as Record<
              string,
              unknown
            >
            const data = await gqlFetch<{
              updateBasMarketInstrument: { errors: { message: string }[] | null }
            }>(UPDATE, { id: drawer!.row!.id, input: rest })
            errors = data.updateBasMarketInstrument.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '行情品种已创建' : '行情品种已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'basMarketInstruments'] })
        }}
      />
    </>
  )
}
