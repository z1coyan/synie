import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { EmptyState, InlineSelect } from '@heroui-pro/react'
import { Button, ListBox, Spinner, toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { accountClient, initializeAccountTemplate } from '~/lib/resources/accounts'
import { companyClient } from '~/lib/resources/companies'
import { currencyClient } from '~/lib/resources/currencies'

export const Route = createFileRoute('/_app/base/accounts')({
  component: AccountsPage,
})

const TEMPLATES = [
  { value: 'CAS', label: '企业会计准则' },
  { value: 'SMALL', label: '小企业会计准则' },
  { value: 'INTL', label: '国际通用(精简)' },
] as const

type Template = (typeof TEMPLATES)[number]['value']

function companyFilter(companyId: string): FilterState {
  return {
    companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
  }
}

function AccountsPage() {
  const queryClient = useQueryClient()
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [template, setTemplate] = useState<Template>('CAS')
  const [initializing, setInitializing] = useState(false)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const companies = useQuery({
    queryKey: ['accountsCompanies', companyClient.id],
    queryFn: () =>
      companyClient.query({
        limit: 50,
        offset: 0,
        sort: { column: 'code', direction: 'ascending' },
      }),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

  const accountCount = useQuery({
    queryKey: ['accountsCount', accountClient.id, companyId, reloadKey],
    enabled: companyId != null,
    queryFn: () =>
      accountClient
        .query({
          limit: 1,
          offset: 0,
          fixedFilter: companyFilter(companyId!),
        })
        .then((result) => result.count),
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', accountClient.id, 'basAccounts'] })
    setReloadKey((key) => key + 1)
  }

  const handleInit = async () => {
    if (companyId == null) return
    setInitializing(true)
    const id = toast('正在初始化科目表…', { isLoading: true, timeout: 0 })
    try {
      const result = await initializeAccountTemplate(companyId, template)
      toast.close(id)
      toast.success(`已创建 ${result.createdCount} 个科目`)
      refresh()
    } catch (error) {
      toast.close(id)
      toast.danger('初始化失败', { description: (error as Error).message })
    } finally {
      setInitializing(false)
    }
  }

  const fixedFilter = companyId == null ? undefined : companyFilter(companyId)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">科目表</h1>
      <p className="mt-2 text-sm text-ink-500">按公司维护会计科目,支持多级科目树。</p>

      <div className="mt-6 max-w-xs">
        <RemoteSelect
          resource="basCompanies"
          client={companyClient}
          label="公司"
          placeholder="选择公司…"
          value={companyId}
          initialRows={companyRow ? [companyRow] : (companies.data?.results ?? [])}
          onChange={(id, row) => {
            setCompanyId(id)
            setCompanyRow(row)
          }}
        />
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>科目表按公司维护,选择公司后查看或初始化其科目。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : accountCount.isPending ? (
          <div className="flex h-64 items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : accountCount.data === 0 ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>该公司还没有科目</EmptyState.Title>
              <EmptyState.Description>选择一套标准模板一键初始化,后续可自行增删调整。</EmptyState.Description>
            </EmptyState.Header>
            <EmptyState.Content>
              <div className="flex items-center gap-3">
                <InlineSelect
                  aria-label="科目表模板"
                  value={template}
                  onChange={(value) => value != null && setTemplate(String(value) as Template)}
                >
                  <InlineSelect.Trigger>
                    <InlineSelect.Value />
                    <InlineSelect.Indicator />
                  </InlineSelect.Trigger>
                  <InlineSelect.Popover className="w-[220px]">
                    <ListBox>
                      {TEMPLATES.map((item) => (
                        <ListBox.Item key={item.value} id={item.value} textValue={item.label}>
                          {item.label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </InlineSelect.Popover>
                </InlineSelect>
                <Button variant="primary" isPending={initializing} onPress={handleInit}>
                  从模板初始化
                </Button>
              </div>
            </EmptyState.Content>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={`${companyId}-${reloadKey}`}
            resource="basAccounts"
            client={accountClient}
            exclude={['parentId', 'companyId', 'hasChildren']}
            tree={{ hasChildrenField: 'hasChildren', sort: { field: 'code', order: 'ASC' } }}
            fixedFilter={fixedFilter}
            onView={(row) => setDrawer({ mode: 'view', row })}
            onCreate={() => setDrawer({ mode: 'create', row: null })}
            onEdit={(row) => setDrawer({ mode: 'edit', row })}
            rowActions={statusToggleActions({
              field: 'active',
              update: accountClient.update,
              onDone: refresh,
            })}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="basAccounts"
        client={accountClient}
        label="科目"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={['active']}
        fields={{
          code: { required: true, edit: 'createOnly', cols: 6, placeholder: '如 1001' },
          name: { required: true, cols: 6, placeholder: '如 库存现金' },
          direction: { required: true, cols: 6 },
          isGroup: {
            cols: 6,
            defaultValue: false,
            effects: (value) => (value === true ? { role: null } : undefined),
          },
          currencyId: {
            cols: 6,
            label: '币种',
            remote: {
              client: currencyClient,
              filterState: { active: { kind: 'bool', eq: true } },
            },
          },
          role: { cols: 6, visible: (values) => values.isGroup !== true },
          parentId: {
            cols: 6,
            label: '上级科目',
            remote: {
              client: accountClient,
              filterState: companyId == null ? undefined : companyFilter(companyId),
            },
          },
          companyId: { visible: () => false },
          childrenCount: { visible: () => false },
        }}
        onEdit={() => setDrawer((current) => (current ? { ...current, mode: 'edit' } : current))}
        onSubmit={async (values, mode) => {
          const input = values.isGroup === true ? { ...values, role: null } : values
          if (mode === 'create') {
            await accountClient.create({ ...input, companyId })
          } else {
            await accountClient.update(drawer!.row!.id, input)
          }
          toast.success(mode === 'create' ? '科目已创建' : '科目已更新')
          refresh()
        }}
      />
    </>
  )
}
