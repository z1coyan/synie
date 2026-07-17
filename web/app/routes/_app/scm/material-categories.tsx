import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/material-categories')({
  component: MaterialCategoriesPage,
})

const CREATE_CATEGORY = `
  mutation ($input: CreateInvMaterialCategoryInput!) {
    createInvMaterialCategory(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_CATEGORY = `
  mutation ($id: ID!, $input: UpdateInvMaterialCategoryInput!) {
    updateInvMaterialCategory(id: $id, input: $input) { result { id } errors { message } }
  }
`

function MaterialCategoriesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  // 树的子层缓存在表格组件本地,写后 invalidate 只能刷新根层——一并 remount 清空子层与展开态
  const [reloadKey, setReloadKey] = useState(0)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">物料分类</h1>
      <p className="mt-2 text-sm text-ink-500">全局共享的物料分类树,分类编号将来作为物料编号前缀。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="invMaterialCategories"
          exclude={['parentId', 'hasChildren']}
          tree={{ hasChildrenField: 'hasChildren', sort: { field: 'code', order: 'ASC' } }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={statusToggleActions({
            field: 'active',
            mutation: UPDATE_CATEGORY,
            resultKey: 'updateInvMaterialCategory',
            // 树的子层缓存在组件本地,refetch 只刷根层,remount 一并清子层
            onDone: () => setReloadKey((k) => k + 1),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource="invMaterialCategories"
        label="物料分类"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        // 启用是状态不是表单字段(规范):新建默认启用,启停走列表行动作;叶子是固有属性留在表单
        exclude={['active']}
        fields={{
          code: { required: true, cols: 6, placeholder: '如 01、0101' },
          name: { required: true, cols: 6, placeholder: '如 原材料' },
          isLeaf: { cols: 6, defaultValue: true },
          parentId: {
            label: '上级分类',
            // 候选限定非叶子分类(叶子不能挂子分类,后端另有校验兜底)
            remote: { filter: '{isLeaf: {eq: false}}' },
          },
          hasChildren: { visible: () => false },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createInvMaterialCategory: { errors: { message: string }[] | null } }>(
              CREATE_CATEGORY,
              { input: values }
            )
            errors = data.createInvMaterialCategory.errors
          } else {
            const data = await gqlFetch<{ updateInvMaterialCategory: { errors: { message: string }[] | null } }>(
              UPDATE_CATEGORY,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateInvMaterialCategory.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '分类已创建' : '分类已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'invMaterialCategories'] })
          // 抽屉走 rowId 自查,编辑后一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'invMaterialCategories'] })
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
