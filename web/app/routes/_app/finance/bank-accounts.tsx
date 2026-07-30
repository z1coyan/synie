import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { useCatalogBasicForm } from '~/lib/resources/catalog'

export const Route = createFileRoute('/_app/finance/bank-accounts')({
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
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const { binding, client, formProps } = useCatalogBasicForm(RESOURCE, '银行账户')

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">银行账户</h1>
      <p className="mt-2 text-sm text-ink-500">公司名下的银行账户主数据,为银行流水与对账做准备。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          client={client}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={statusToggleActions({
            field: 'active',
            update: (id, input) => {
              if (!binding.writer || !('update' in binding.writer) || !binding.writer.update) {
                throw new Error('银行账户不支持 update')
              }
              return binding.writer.update(id, input)
            },
            rowLabel: (row) => String(row.alias ?? ''),
            onDone: () => queryClient.invalidateQueries({ queryKey: ['rowById', RESOURCE] }),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        client={client}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        exclude={[...formProps.exclude, 'active']}
        fields={{
          ...formProps.fields,
          companyId: {
            ...formProps.fields.companyId,
            order: -1,
            effects: () => ({ accountId: null }),
          },
          accountId: {
            ...formProps.fields.accountId,
            order: 7,
            cols: 6,
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
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (!binding.writer) throw new Error('银行账户不支持写入')
          if (mode === 'create') {
            if (!('create' in binding.writer) || !binding.writer.create) {
              throw new Error('银行账户不支持 create')
            }
            await binding.writer.create(values)
          } else {
            if (!('update' in binding.writer) || !binding.writer.update) {
              throw new Error('银行账户不支持 update')
            }
            await binding.writer.update(drawer!.row!.id, values)
          }
          toast.success(mode === 'create' ? '银行账户已创建' : '银行账户已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', RESOURCE] })
        }}
      />
    </>
  )
}
