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
import { useResourceBinding } from '~/lib/resources/resource-context'
import {
  createAccountPresentation,
  submitAccountForm,
} from '~/lib/resources/presentation'

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
  const companyBinding = useResourceBinding('basCompanies')
  const accountBinding = useResourceBinding('basAccounts')

  const companies = useQuery({
    queryKey: companyBinding.cache.gridKey('accounts-company-picker'),
    queryFn: () => companyBinding.reader.query({ profile: 'default', numItems: 50, cursor: null }),
  })

  useEffect(() => {
    // 默认第一家授权公司(按 code 升序),多公司时用户仍可切换
    if (companyId == null && (companies.data?.results?.length ?? 0) >= 1) {
      const first = companies.data!.results[0]
      setCompanyId(first.id)
      setCompanyRow(first)
    }
  }, [companies.data, companyId])

  const accountCount = useQuery({
    queryKey: accountBinding.cache.gridKey('count', companyId, reloadKey),
    enabled: companyId != null,
    queryFn: () =>
      accountBinding.reader.query({ profile: 'default', numItems: 1, cursor: null, fixedFilter: companyFilter(companyId!) }).then((result) => result.totalCount ?? result.results.length),
  })

  const refresh = () => {
    void accountBinding.cache.invalidateGrid(queryClient)
    setReloadKey((key) => key + 1)
  }

  const handleInit = async () => {
    if (companyId == null) return
    setInitializing(true)
    const id = toast('正在初始化科目表…', { isLoading: true, timeout: 0 })
    try {
      if (!accountBinding.commands) throw new Error('科目表未绑定初始化命令')
      const result = await accountBinding.commands.execute(
        'initializeTemplate',
        { companyId, template },
      ) as { createdCount: number }
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
            exclude={['parentId', 'companyId', 'hasChildren']}
            tree={{ hasChildrenField: 'hasChildren', sort: { field: 'code', order: 'ASC' } }}
            fixedFilter={fixedFilter}
            onView={(row) => setDrawer({ mode: 'view', row })}
            onCreate={() => setDrawer({ mode: 'create', row: null })}
            onEdit={(row) => setDrawer({ mode: 'edit', row })}
            rowActions={statusToggleActions({
              field: 'active',
              update: (id, input) => {
                if (!accountBinding.writer || !('update' in accountBinding.writer) || !accountBinding.writer.update) throw new Error('科目不支持 update')
                return accountBinding.writer.update(id, input)
              },
              onDone: refresh,
            })}
          />
        )}
      </div>

      <AccountDrawer
        companyId={companyId}
        drawer={drawer}
        onClose={() => setDrawer(null)}
        onEdit={() => setDrawer((current) => (current ? { ...current, mode: 'edit' } : current))}
        onSaved={refresh}
      />
    </>
  )
}

function AccountDrawer(props: {
  companyId: string | null
  drawer: { mode: DrawerMode; row: Row | null } | null
  onClose: () => void
  onEdit: () => void
  onSaved: () => void
}) {
  const binding = useResourceBinding('basAccounts')
  const presentation = createAccountPresentation(binding, {
    companyId: props.companyId,
    companyFilter:
      props.companyId == null ? undefined : companyFilter(props.companyId),
  })

  return (
    <SynieRecordDrawer
      resource="basAccounts"
      label={presentation.label}
      mode={props.drawer?.mode ?? 'view'}
      isOpen={props.drawer !== null}
      onOpenChange={(open) => !open && props.onClose()}
      row={props.drawer?.row}
      exclude={presentation.exclude}
      fields={presentation.fields}
      onEdit={props.onEdit}
      onSubmit={async (values, mode) => {
        await submitAccountForm(
          presentation,
          values,
          mode,
          props.drawer?.row?.id as string | undefined,
          props.companyId,
        )
        toast.success(mode === 'create' ? '科目已创建' : '科目已更新')
        props.onSaved()
      }}
    />
  )
}
