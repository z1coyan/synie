import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Chip, toast } from '@heroui/react'
import { roleClient } from '~/lib/resources/iam'
import { useResourceCapabilities } from '~/lib/use-resource-capabilities'
import { resourceBindingFor } from '~/lib/resources/registry'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieRoleAccessSheet } from '~/components/synie-role-access-sheet/SynieRoleAccessSheet'
import type { Row } from '~/components/synie-data-grid/types'

const RESOURCE = 'sysRoles'

export const Route = createFileRoute('/_app/system/roles')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: RolesPage,
})

// 内置角色(迁移种子的 admin,持全域通配 * 授权):后端强制不可改/不可删,前端对应禁用入口
const notBuiltin = (row: Row) => row.builtin !== true

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  builtin: {
    label: '内置',
    render: (v) =>
      v === true ? (
        <Chip size="sm" variant="soft" color="accent">
          内置
        </Chip>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
}

function RolesPage() {
  const { drawer, open, setMode, close, row: drawerRow } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const [accessRole, setAccessRole] = useState<Row | null>(null)
  // 「权限与菜单」入口按角色权限/角色菜单两资源文档投影门控(fail-closed:文档 403 即不可见)
  const rolePermCaps = useResourceCapabilities('sysRolePermissions')
  const roleMenuCaps = useResourceCapabilities('sysRoleMenus')

  // 两区门控刻意分离(ADR 2026-08-01 第 10 条):功能权限要可读、编辑要 create+delete;
  // 菜单白名单要可读/update——合并抽屉只合容器,不合门控,任一可读即见入口
  const canViewPerms = rolePermCaps.readable
  const canWritePerms = rolePermCaps.has('create') && rolePermCaps.has('delete')
  const canViewMenus = roleMenuCaps.readable
  const canWriteMenus = roleMenuCaps.has('update')

  // 关闭动画期间冻结 builtin:accessRole 置空后不能当场翻回 false(同 lastOpenRef 模式)
  const builtinRef = useRef(false)
  if (accessRole) builtinRef.current = accessRole.builtin === true
  const accessBuiltin = accessRole ? accessRole.builtin === true : builtinRef.current

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          overrides={GRID_OVERRIDES}
          // 内置角色:禁用编辑/启停开关与删除(后端另有强制校验兜底);「权限与菜单」保留入口但两区只读
          actionVisible={{
            edit: notBuiltin,
            delete: notBuiltin,
            statusEnable: notBuiltin,
            statusDisable: notBuiltin,
          }}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          rowActions={[
            ...(canViewPerms || canViewMenus
              ? [{ key: 'access', label: '权限与菜单', onAction: (row: Row) => setAccessRole(row) }]
              : []),
            // 停用角色即收回其全部权限贡献,状态翻转走行动作不进表单(规范)
            ...statusToggleActions({
              field: 'enabled',
              update: roleClient.update.bind(roleClient),
              onDone: () =>
                resourceBindingFor(RESOURCE).cache.invalidateGrid(queryClient),
            }),
          ]}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        {...drawerConfig(RESOURCE)}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        // 内置角色详情页不提供「编辑」入口(行内编辑入口已被 actionVisible 隐藏,这里是第二处)
        onEdit={
          drawerRow?.builtin === true ? undefined : () => setMode('edit')
        }
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await roleClient.create(values)
          } else {
            await roleClient.update(String(drawer!.recordId), values)
          }
          toast.success(mode === 'create' ? '角色已创建' : '角色已更新')
          await resourceBindingFor(RESOURCE).cache.invalidateGrid(queryClient)
        }}
      />

      <SynieRoleAccessSheet
        roleId={accessRole?.id ?? ''}
        roleName={String(accessRole?.name ?? '')}
        builtin={accessBuiltin}
        isOpen={accessRole !== null}
        onOpenChange={(isOpen) => !isOpen && setAccessRole(null)}
        perms={{ canView: canViewPerms, canWrite: canWritePerms }}
        menus={{ canView: canViewMenus, canWrite: canWriteMenus }}
      />
    </>
  )
}
