import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { useCatalogBasicForm, requireWriter } from '~/lib/resources/catalog'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

const RESOURCE = 'invMaterialCategories'

export const Route = createFileRoute('/_app/scm/material-categories')({
  // 树形网格,跳过默认首屏 loader
  component: MaterialCategoriesPage,
})

function MaterialCategoriesPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  // 树的子层缓存在表格组件本地,写后 invalidate 只能刷新根层——一并 remount 清空子层与展开态
  const [reloadKey, setReloadKey] = useState(0)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '物料分类')

  return (
    <>
      <h1 className="font-brand text-xl">物料分类</h1>
      <p className="mt-1 text-xs text-ink-500">全局共享的物料分类树,分类编号将来作为物料编号前缀。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource={RESOURCE}
          exclude={['parentId', 'hasChildren']}
          tree={{ hasChildrenField: 'hasChildren', sort: { field: 'code', order: 'ASC' } }}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          rowActions={statusToggleActions({
            field: 'active',
            update: (id, input) => {
              return requireWriter(binding, 'update')(id, input)
            },
            // 树的子层缓存在组件本地,refetch 只刷根层,remount 一并清子层
            onDone: () => setReloadKey((k) => k + 1),
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
        exclude={formProps.exclude}
        fields={formProps.fields}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await requireWriter(binding, 'create')(values)
          } else {
            await requireWriter(binding, 'update')(String(drawer!.recordId), values)
          }
          toast.success(mode === 'create' ? '分类已创建' : '分类已更新')
          await binding.cache.invalidateAll(queryClient)
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
