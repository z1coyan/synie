import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import {
  useCatalogBasicForm,
  requireWriter,
} from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

export const Route = createFileRoute('/_app/finance/bank-accounts')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: BankAccountsPage,
})

const RESOURCE = 'accBankAccounts'

const GRID_COLUMNS = [
  'companyId',
  'alias',
  'bankName',
  'accountNo',
  'holderName',
  'currencyId',
  'accountId',
  'active',
]

const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  companyId: { mobileRole: 'hide' },
  alias: { mobileRole: 'title' },
  bankName: { mobileRole: 'subtitle' },
  accountNo: { mobileRole: 'summary' },
  currencyId: { mobileRole: 'summary' },
  active: { mobileRole: 'summary' },
}

function BankAccountsPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '银行账户')

  return (
    <>
      <h1 className="font-brand text-xl">银行账户</h1>
      <p className="mt-1 text-xs text-ink-500">公司名下的银行账户主数据,为银行流水与对账做准备。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          rowActions={statusToggleActions({
            field: 'active',
            update: (id, input) => {
              return requireWriter(binding, 'update')(id, input)
            },
            rowLabel: (row) => String(row.alias ?? ''),
            onDone: () => binding.cache.invalidateRow(queryClient),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        exclude={[...formProps.exclude, 'active']}
        fields={{
          ...formProps.fields,
          companyId: {
            ...formProps.fields.companyId,
            effects: () => ({ accountId: null }),
          },
          accountId: {
            ...formProps.fields.accountId,
            input: ({ value, onChange, isDisabled, values }) => {
              const companyId = (values.companyId ?? null) as string | null
              return (
                <RemoteSelect
                  resource="basAccounts"
                  label="绑定科目"
                  placeholder={companyId ? '选择入账科目…' : '先选择公司'}
                  value={value == null ? null : String(value)}
                  onChange={(id) => onChange(id)}
                  isDisabled={isDisabled || companyId == null}
                  filterState={{
                    companyId: { kind: 'fk', values: [companyId!], labels: [] },
                    isGroup: { kind: 'bool', eq: false },
                    active: { kind: 'bool', eq: true },
                  }}
                />
              )
            },
          },
        }}
        extraContent={(mode, row) => (
          <SynieAttachmentPanel
            ownerType="acc_bank_account"
            ownerId={row?.id as string | undefined}
            readonly={mode === 'view'}
          />
        )}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await requireWriter(binding, 'create')(values)
          } else {
            await requireWriter(binding, 'update')(String(drawer!.recordId), values)
          }
          toast.success(mode === 'create' ? '银行账户已创建' : '银行账户已更新')
          await binding.cache.invalidateGrid(queryClient)
        }}
      />
    </>
  )
}
