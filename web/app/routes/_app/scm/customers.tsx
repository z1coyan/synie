import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/customers')({
  component: CustomersPage,
})

const CREATE_CUSTOMER = `
  mutation ($input: CreateSalCustomerInput!) {
    createSalCustomer(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_CUSTOMER = `
  mutation ($id: ID!, $input: UpdateSalCustomerInput!) {
    updateSalCustomer(id: $id, input: $input) { result { id } errors { message } }
  }
`

function CustomersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">客户管理</h1>
      <p className="mt-2 text-sm text-ink-500">销售往来的客户主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="salCustomers"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="salCustomers"
        label="客户"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, placeholder: '如 C0001' },
          name: { required: true, placeholder: '客户全称' },
          shortName: { placeholder: '如 华为' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createSalCustomer: { errors: { message: string }[] | null } }>(
              CREATE_CUSTOMER,
              { input: values }
            )
            errors = data.createSalCustomer.errors
          } else {
            const data = await gqlFetch<{ updateSalCustomer: { errors: { message: string }[] | null } }>(
              UPDATE_CUSTOMER,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateSalCustomer.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '客户已创建' : '客户已更新')
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
