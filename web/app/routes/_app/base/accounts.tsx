import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState, InlineSelect } from '@heroui-pro/react'
import { Button, ListBox, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/accounts')({
  component: AccountsPage,
})

const CREATE_ACCOUNT = `
  mutation ($input: CreateBasAccountInput!) {
    createBasAccount(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ACCOUNT = `
  mutation ($id: ID!, $input: UpdateBasAccountInput!) {
    updateBasAccount(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 泛型 action 返回标量(创建条数),AshGraphql 不做 result/errors 包装,直接返回 Int;错误走 top-level errors 由 gqlFetch 抛出
const INIT_FROM_TEMPLATE = `
  mutation ($input: InitBasAccountFromTemplateInput!) {
    initBasAccountFromTemplate(input: $input)
  }
`

const TEMPLATES = [
  { value: 'CAS', label: '企业会计准则' },
  { value: 'SMALL', label: '小企业会计准则' },
  { value: 'INTL', label: '国际通用(精简)' },
]

function AccountsPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [template, setTemplate] = useState('CAS')
  const [initializing, setInitializing] = useState(false)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // 公司列表:仅一家时自动选中,并作为选择器回显数据
  const companies = useQuery({
    queryKey: ['accountsCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name } } }`
      ).then((d) => d.basCompanies),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

  // 该公司科目数:0 走模板初始化空态,>0 走树形表格
  const accountCount = useQuery({
    queryKey: ['accountsCount', companyId, reloadKey],
    enabled: companyId != null,
    queryFn: () =>
      gqlFetch<{ basAccounts: { count: number } }>(
        `query { basAccounts(limit: 1, offset: 0, filter: {companyId: {eq: ${JSON.stringify(companyId)}}}) { count } }`
      ).then((d) => d.basAccounts.count),
  })

  const handleInit = async () => {
    setInitializing(true)
    const id = toast('正在初始化科目表…', { isLoading: true, timeout: 0 })
    try {
      const d = await gqlFetch<{ initBasAccountFromTemplate: number }>(INIT_FROM_TEMPLATE, {
        input: { companyId, template },
      })
      toast.close(id)
      toast.success(`已创建 ${d.initBasAccountFromTemplate} 个科目`)
      setReloadKey((k) => k + 1)
    } catch (e) {
      toast.close(id)
      toast.danger('初始化失败', { description: (e as Error).message })
    } finally {
      setInitializing(false)
    }
  }

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
                  onChange={(v) => v != null && setTemplate(String(v))}
                >
                  <InlineSelect.Trigger>
                    <InlineSelect.Value />
                    <InlineSelect.Indicator />
                  </InlineSelect.Trigger>
                  <InlineSelect.Popover className="w-[220px]">
                    <ListBox>
                      {TEMPLATES.map((t) => (
                        <ListBox.Item key={t.value} id={t.value} textValue={t.label}>
                          {t.label}
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
            fixedFilter={{ companyId: { eq: companyId } }}
            onView={(row) => setDrawer({ mode: 'view', row })}
            onCreate={() => setDrawer({ mode: 'create', row: null })}
            onEdit={(row) => setDrawer({ mode: 'edit', row })}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="basAccounts"
        label="科目"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, cols: 6, placeholder: '如 1001' },
          name: { required: true, cols: 6, placeholder: '如 库存现金' },
          direction: { required: true, cols: 6 },
          isGroup: { cols: 6, defaultValue: false },
          active: { cols: 6, defaultValue: true },
          currencyId: { cols: 6, label: '币种' },
          // 科目角色:应收应付报表按角色圈定科目;仅叶子科目可挂(汇总科目隐藏,后端另有校验兜底)
          role: { cols: 6, visible: (v) => v.isGroup !== true },
          parentId: {
            cols: 6,
            label: '上级科目',
            // 候选限定在当前公司(后端另有同公司校验兜底)
            remote: { filter: `{companyId: {eq: ${JSON.stringify(companyId)}}}` },
          },
          // 公司由页面顶部选定,表单不显示,提交时注入
          companyId: { visible: () => false },
          childrenCount: { visible: () => false },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createBasAccount: { errors: { message: string }[] | null } }>(
              CREATE_ACCOUNT,
              { input: { ...values, companyId } }
            )
            errors = data.createBasAccount.errors
          } else {
            const data = await gqlFetch<{ updateBasAccount: { errors: { message: string }[] | null } }>(
              UPDATE_ACCOUNT,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateBasAccount.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '科目已创建' : '科目已更新')
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
