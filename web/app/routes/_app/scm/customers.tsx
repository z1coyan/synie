import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import {
  decodeCustomerCreate,
  decodeCustomerUpdate,
  useCatalogBasicForm,
  requireWriter,
  resourceLabel,
} from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import {
  PARTY_ADDRESS_DRAWER_TABS,
  PartyAddressesSection,
} from '~/components/party-addresses/PartyAddressesSection'

export const Route = createFileRoute('/_app/scm/customers')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: CustomersPage,
})

// 卡片:名称标题、编号副标题、简称摘要(查客户首看叫什么)
const GRID_OVERRIDES = {
  name: { mobileRole: 'title' },
  code: { mobileRole: 'subtitle' },
  shortName: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

const RESOURCE = 'salCustomers'

function CustomersPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '客户')

  const invalidate = () =>
    binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-xl">客户管理</h1>
      <p className="mt-1 text-xs text-ink-500">销售往来的客户主数据,编号现阶段手工维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          overrides={GRID_OVERRIDES}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
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
        tabs={[...PARTY_ADDRESS_DRAWER_TABS]}
        onEdit={() => setMode('edit')}
        tabExtraContent={{
          addresses: (mode, row) => (
            <PartyAddressesSection
              partyType="CUSTOMER"
              partyId={row?.id ? String(row.id) : drawer?.recordId ?? undefined}
              readonly={mode === 'view'}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const input = decodeCustomerCreate(values)
            const saved = await requireWriter(binding, 'create')({ ...input })
            toast.success(`${resourceLabel('salCustomers')}已创建`)
            invalidate()
            return saved.id as string
          }
          const input = decodeCustomerUpdate(values)
          const saved = await requireWriter(binding, 'update')(String(drawer!.recordId), {
            ...input,
          })
          toast.success(`${resourceLabel('salCustomers')}已更新`)
          invalidate()
          return saved.id as string
        }}
      />
    </>
  )
}
