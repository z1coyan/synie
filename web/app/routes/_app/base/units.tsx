import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/units')({
  component: UnitsPage,
})

const CREATE_UNIT = `
  mutation ($input: CreateBasUnitInput!) {
    createBasUnit(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_UNIT = `
  mutation ($id: ID!, $input: UpdateBasUnitInput!) {
    updateBasUnit(id: $id, input: $input) { result { id } errors { message } }
  }
`

function UnitsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">单位管理</h1>
      <p className="mt-2 text-sm text-ink-500">计量单位主数据,每类型一个基准单位,其余按比例换算。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="basUnits"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="basUnits"
        label="单位"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          unitType: { required: true },
          name: { required: true, placeholder: '如 千克', cols: 6 },
          symbol: { required: true, placeholder: '如 kg', cols: 6 },
          // 基准单位比例恒为 1(后端校验);普通单位填换算到基准单位的比例,如 kg 为基准时克填 0.001
          ratio: { required: true, defaultValue: 1, placeholder: '换算到基准单位的比例' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createBasUnit: { errors: { message: string }[] | null } }>(
              CREATE_UNIT,
              { input: values }
            )
            errors = data.createBasUnit.errors
          } else {
            const data = await gqlFetch<{ updateBasUnit: { errors: { message: string }[] | null } }>(
              UPDATE_UNIT,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateBasUnit.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '单位已创建' : '单位已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'basUnits'] })
        }}
      />
    </>
  )
}
