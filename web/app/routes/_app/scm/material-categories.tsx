import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { useCatalogBasicForm,
  requireWriter,} from '~/lib/resources/catalog'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/material-categories')({
  component: MaterialCategoriesPage,
})

const RESOURCE = 'invMaterialCategories'

function MaterialCategoriesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  // 树的子层缓存在表格组件本地,写后 invalidate 只能刷新根层——一并 remount 清空子层与展开态
  const [reloadKey, setReloadKey] = useState(0)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '物料分类')

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">物料分类</h1>
      <p className="mt-2 text-sm text-ink-500">全局共享的物料分类树,分类编号将来作为物料编号前缀。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource={RESOURCE}
          exclude={['parentId', 'hasChildren']}
          tree={{ hasChildrenField: 'hasChildren', sort: { field: 'code', order: 'ASC' } }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={statusToggleActions({
            field: 'active',
            update: (id, input) => {
              return requireWriter(binding, 'update', '物料分类')(id, input)
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
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={formProps.exclude}
        fields={formProps.fields}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await requireWriter(binding, 'create', '物料分类')(values)
          } else {
            await requireWriter(binding, 'update', '物料分类')(String(drawer!.row!.id), values)
          }
          toast.success(mode === 'create' ? '分类已创建' : '分类已更新')
          await binding.cache.invalidateAll(queryClient)
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
