import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, toast } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/warehouses')({
  component: WarehousesPage,
})

const CREATE_WAREHOUSE = `
  mutation ($input: CreateInvWarehouseInput!) {
    createInvWarehouse(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_WAREHOUSE = `
  mutation ($id: ID!, $input: UpdateInvWarehouseInput!) {
    updateInvWarehouse(id: $id, input: $input) { result { id } errors { message } }
  }
`

// 列白名单:公司由页面顶部选定不进列,时间戳不进表格
const GRID_COLUMNS = ['name', 'parentId', 'accountId', 'isLeaf', 'isOutsourced', 'allowNegative', 'active']

/** 关联科目列:「编号-名称」,点击开科目速览(join 默认只取 id/name,code 经 joinFields 追加取回,同物料分类列先例) */
function AccountCell({ row }: { row: Row }) {
  const openPreview = useFkPreview()
  const id = row.accountId == null || row.accountId === '' ? null : String(row.accountId)
  const account = (row.account as Row | null | undefined) ?? null
  if (!id) return <span className="text-muted">—</span>
  // join 缺失(科目读权限被裁剪):退截断 id,不给点不开的 link
  if (!account) return <>{id.slice(0, 8)}</>
  const text = [account.code, account.name].filter((s) => s != null && s !== '').join('-')
  return (
    <Link
      onPress={() => openPreview('basAccounts', String(account.id ?? id))}
      className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  )
}

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  accountId: { render: (_value, row) => <AccountCell row={row} /> },
  // 两个占位标记:meta 描述带「(占位,暂无逻辑)」太长,列头用短名
  isOutsourced: { label: '外协仓' },
  allowNegative: { label: '负库存' },
}

function WarehousesPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  // 树的子层缓存在表格组件本地,写后 invalidate 只能刷新根层——一并 remount 清空子层与展开态
  const [reloadKey, setReloadKey] = useState(0)
  const queryClient = useQueryClient()

  // 公司列表:仅一家时自动选中,并作为选择器回显数据(同科目表页先例)
  const companies = useQuery({
    queryKey: ['warehouseCompanies'],
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

  // 上级候选:同公司、非叶子,编辑时排除自身(下级的排除后端兜底)
  const parentFilter = [
    `{companyId: {eq: ${JSON.stringify(companyId)}}}`,
    '{isLeaf: {eq: false}}',
    ...(drawer?.row?.id ? [`{id: {notEq: ${JSON.stringify(drawer.row.id)}}}`] : []),
  ].join(', ')
  // 关联科目候选:本公司、非汇总、本币(未指定币种)科目(后端另有同公司/汇总/币种校验兜底)
  const accountFilter = `{companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, currencyId: {isNil: true}}`

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">仓库管理</h1>
      <p className="mt-2 text-sm text-ink-500">按公司维护仓库树;外协仓/负库存为占位标记,暂无业务联动。</p>

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
              <EmptyState.Description>仓库按公司维护,选择公司后查看其仓库树。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={`${companyId}-${reloadKey}`}
            resource="invWarehouses"
            columns={GRID_COLUMNS}
            tree={{ hasChildrenField: 'hasChildren', sort: { field: 'name', order: 'ASC' } }}
            fixedFilter={{ companyId: { eq: companyId } }}
            joinFields={{ account: ['code'] }}
            overrides={GRID_OVERRIDES}
            onView={(row) => setDrawer({ mode: 'view', row })}
            onCreate={() => setDrawer({ mode: 'create', row: null })}
            onEdit={(row) => setDrawer({ mode: 'edit', row })}
            rowActions={statusToggleActions({
              field: 'active',
              mutation: UPDATE_WAREHOUSE,
              resultKey: 'updateInvWarehouse',
              // 树的子层缓存在组件本地,refetch 只刷根层,remount 一并清子层
              onDone: () => setReloadKey((k) => k + 1),
            })}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="invWarehouses"
        label="仓库"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无时间戳),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        // 启用是状态不是表单字段(规范):新建默认启用,启停走列表行动作;叶子是固有属性留在表单
        exclude={['active']}
        fields={{
          name: { order: 0, required: true, placeholder: '如 原材料仓' },
          parentId: {
            order: 1,
            label: '上级仓库',
            remote: { filter: `{and: [${parentFilter}]}` },
          },
          // 默认叶子;要建归集节点(挂子仓)手动关掉,与物料分类同语义
          isLeaf: { order: 2, cols: 6, defaultValue: true },
          accountId: {
            order: 3,
            cols: 6,
            label: '关联科目',
            remote: { filter: accountFilter, searchFields: ['name', 'code'], itemSubtitleFields: ['code'] },
          },
          // 两个占位开关,默认都关
          isOutsourced: { order: 4, cols: 6, label: '外协仓', defaultValue: false },
          allowNegative: { order: 5, cols: 6, label: '允许负库存', defaultValue: false },
          // 公司由页面顶部选定,表单不显示,提交时注入
          companyId: { visible: () => false },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createInvWarehouse: { errors: { message: string }[] | null } }>(
              CREATE_WAREHOUSE,
              { input: { ...values, companyId } }
            )
            errors = data.createInvWarehouse.errors
          } else {
            const data = await gqlFetch<{ updateInvWarehouse: { errors: { message: string }[] | null } }>(
              UPDATE_WAREHOUSE,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateInvWarehouse.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '仓库已创建' : '仓库已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'invWarehouses'] })
          // 抽屉走 rowId 自查,编辑后一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'invWarehouses'] })
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
