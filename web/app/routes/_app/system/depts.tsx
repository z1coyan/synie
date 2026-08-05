import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { EmptyState } from '@heroui-pro/react'
import { toast } from '@heroui/react'
import { useCatalogBasicForm, requireWriter } from '~/lib/resources/catalog'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { FilterState, Row } from '~/components/synie-data-grid/types'

const RESOURCE = 'sysDepartments'

export const Route = createFileRoute('/_app/system/depts')({
  // 树形 + 按公司 fixedFilter,非默认首屏,跳过 loader
  component: DepartmentsPage,
})

function companyFilter(companyId: string): FilterState {
  return { companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] } }
}

function DepartmentsPage() {
  const queryClient = useQueryClient()
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '部门')
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  // 树的子层缓存在表格组件本地,写后 invalidate 只刷根层——一并 remount 清子层与展开态
  const [reloadKey, setReloadKey] = useState(0)

  // 公司选择器的候选列表：缓存键与读取都经 binding（web/AGENTS.md：不手写 key、不依赖 transport id）
  const companyBinding = resourceBindingFor('basCompanies')
  const companies = useQuery({
    queryKey: companyBinding.cache.gridKey('deptPicker'),
    queryFn: () =>
      companyBinding.reader.query({
        limit: 50,
        offset: 0,
        sort: { column: 'code', direction: 'ascending' },
      }),
  })

  useEffect(() => {
    // 默认第一家授权公司(按 code 升序);多公司时用户仍可切换
    if (companyId == null && (companies.data?.results?.length ?? 0) >= 1) {
      const first = companies.data!.results[0]
      setCompanyId(first.id)
      setCompanyRow(first)
    }
  }, [companies.data, companyId])

  const refresh = async () => {
    await binding.cache.invalidateAll(queryClient)
    setReloadKey((key) => key + 1)
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">部门管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        部门按公司维护,支持多级组织树。部门是「本部门」「本部门及以下」数据范围的取值来源;
        停用的部门不能再挂用户,已挂接的用户保留不变。
      </p>

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
              <EmptyState.Description>部门按公司维护,选择公司后查看或新增其部门。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={`${companyId}-${reloadKey}`}
            resource={RESOURCE}
            exclude={['parentId', 'companyId', 'hasChildren']}
            tree={{ hasChildrenField: 'hasChildren', sort: { field: 'code', order: 'ASC' } }}
            fixedFilter={companyFilter(companyId)}
            onView={(row) => open('view', String(row.id))}
            onCreate={() => open('create')}
            onEdit={(row) => open('edit', String(row.id))}
            rowActions={statusToggleActions({
              field: 'enabled',
              update: (id, input) => requireWriter(binding, 'update', '部门')(id, input),
              onDone: () => void refresh(),
              hint: {
                disable: '停用后不能再把用户挂到该部门,也不能作为新建部门的上级;已挂接的用户保留不变。',
              },
            })}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        exclude={formProps.exclude}
        fields={{
          ...formProps.fields,
          // 公司由页面顶部选择器决定,不在表单里重复出现(提交时注入)
          companyId: { visible: () => false },
          // 上级候选限本公司且未停用(后端另有同公司/停用/成环校验兜底);
          // 公司未就绪时不下发公司筛选——空串会被列表筛选器当无效 uuid 拒掉
          parentId: {
            ...formProps.fields.parentId,
            remote: {
              filterState: {
                ...(companyId == null ? {} : companyFilter(companyId)),
                enabled: { kind: 'bool', eq: true },
              },
            },
          },
        }}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await requireWriter(binding, 'create', '部门')({ ...values, companyId })
          } else {
            await requireWriter(binding, 'update', '部门')(String(drawer!.recordId), values)
          }
          toast.success(mode === 'create' ? '部门已创建' : '部门已更新')
          await refresh()
        }}
      />
    </>
  )
}
