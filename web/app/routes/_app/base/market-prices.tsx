import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/market-prices')({
  component: MarketPricesPage,
})

const CREATE = `
  mutation ($input: CreateBasMarketPricePointInput!) {
    createBasMarketPricePoint(input: $input) { result { id } errors { message } }
  }
`

const GRID_COLUMNS = [
  'instrumentId',
  'observedAt',
  'price',
  'priceKind',
  'currencyId',
  'unitId',
  'source',
  'isVoided',
  'note',
]

// 已作废不可再作废;无编辑/删除入口(资源无 update/destroy)
const ACTION_VISIBLE = {
  void: (row: Row) => row.isVoided !== true,
} satisfies Record<string, (row: Row) => boolean>

function MarketPricesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">行情价点</h1>
      <p className="mt-2 text-sm text-ink-500">
        不可变价格事实：按品种 + 观测时刻补录；录错请作废后重录，不可改价。币种与单位自动继承自品种。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="basMarketPricePoints"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          actionVisible={ACTION_VISIBLE}
        />
      </div>

      <SynieRecordDrawer
        resource="basMarketPricePoints"
        label="行情价点"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        // 币种/单位由后端从品种继承,不在表单填写;已作废/来源创建后只读展示
        exclude={
          drawer?.mode === 'create'
            ? ['currencyId', 'unitId', 'isVoided', 'source', 'insertedAt', 'updatedAt']
            : ['insertedAt', 'updatedAt']
        }
        fields={{
          instrumentId: { required: true, edit: 'createOnly' },
          observedAt: { required: true, edit: 'createOnly' },
          price: { required: true, edit: 'createOnly', placeholder: '如 72000' },
          priceKind: {
            required: true,
            edit: 'createOnly',
          },
          note: { edit: 'createOnly', placeholder: '可选备注' },
        }}
        onSubmit={async (values, mode) => {
          if (mode !== 'create') return
          const input = { ...values, source: 'MANUAL' } as Record<string, unknown>

          const data = await gqlFetch<{
            createBasMarketPricePoint: { errors: { message: string }[] | null }
          }>(CREATE, { input })
          const errors = data.createBasMarketPricePoint.errors
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success('行情价点已录入')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'basMarketPricePoints'] })
        }}
      />
    </>
  )
}
