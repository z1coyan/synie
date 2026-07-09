import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/suppliers')({
  component: SuppliersPage,
})

const CREATE_SUPPLIER = `
  mutation ($input: CreatePurSupplierInput!) {
    createPurSupplier(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_SUPPLIER = `
  mutation ($id: ID!, $input: UpdatePurSupplierInput!) {
    updatePurSupplier(id: $id, input: $input) { result { id } errors { message } }
  }
`

function SuppliersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">供应商管理</h1>
      <p className="mt-2 text-sm text-ink-500">采购往来的供应商主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="purSuppliers"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="purSuppliers"
        label="供应商"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, placeholder: '如 S0001' },
          name: { required: true, placeholder: '供应商全称' },
          shortName: { placeholder: '如 富士康' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createPurSupplier: { errors: { message: string }[] | null } }>(
              CREATE_SUPPLIER,
              { input: values }
            )
            errors = data.createPurSupplier.errors
          } else {
            const data = await gqlFetch<{ updatePurSupplier: { errors: { message: string }[] | null } }>(
              UPDATE_SUPPLIER,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updatePurSupplier.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '供应商已创建' : '供应商已更新')
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
