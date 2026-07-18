import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Chip, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SyniePermissionSheet } from '~/components/synie-permission-sheet/SyniePermissionSheet'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/roles')({
  component: RolesPage,
})

const CREATE_ROLE = `
  mutation ($input: CreateSysRoleInput!) {
    createSysRole(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ROLE = `
  mutation ($id: ID!, $input: UpdateSysRoleInput!) {
    updateSysRole(id: $id, input: $input) { result { id } errors { message } }
  }
`

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
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const [permRole, setPermRole] = useState<Row | null>(null)
  const [myPerms, setMyPerms] = useState<Set<string>>(new Set())

  // 权限配置入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  useEffect(() => {
    gqlFetch<{ myPermissions: string[] }>('query { myPermissions }')
      .then((d) => setMyPerms(new Set(d.myPermissions)))
      .catch((e) => toast.danger('权限信息加载失败', { description: (e as Error).message }))
  }, [])

  const canConfigure = myPerms.has('sys.role_permission:read')
  const canWrite = myPerms.has('sys.role_permission:create') && myPerms.has('sys.role_permission:delete')

  // 关闭动画期间冻结 builtin:permRole 置空后 readOnly 不能当场翻回 false(同 roleName 的 lastOpenRef 模式)
  const builtinRef = useRef(false)
  if (permRole) builtinRef.current = permRole.builtin === true
  const permReadOnly = !canWrite || (permRole ? permRole.builtin === true : builtinRef.current)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysRoles"
          overrides={GRID_OVERRIDES}
          // 内置角色:禁用编辑/启停开关与删除(后端另有强制校验兜底);配置权限保留入口但矩阵只读
          actionVisible={{
            edit: notBuiltin,
            delete: notBuiltin,
            statusEnable: notBuiltin,
            statusDisable: notBuiltin,
          }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={[
            ...(canConfigure
              ? [{ key: 'permissions', label: '配置权限', onAction: (row: Row) => setPermRole(row) }]
              : []),
            // 停用角色即收回其全部权限贡献,状态翻转走行动作不进表单(规范)
            ...statusToggleActions({ field: 'enabled', mutation: UPDATE_ROLE, resultKey: 'updateSysRole' }),
          ]}
        />
      </div>

      <SynieRecordDrawer
        resource="sysRoles"
        {...drawerConfig('sysRoles')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        // 内置角色详情页不提供「编辑」入口(行内编辑入口已被 actionVisible 隐藏,这里是第二处)
        onEdit={
          drawer?.row?.builtin === true
            ? undefined
            : () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
        }
        onSubmit={async (values, mode) => {
          // 更新/创建两支返回不同字段名,各自取 errors 而非 Object.values(data)[0](那样会退化为 any)
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createSysRole: { errors: { message: string }[] | null } }>(CREATE_ROLE, {
              input: values,
            })
            errors = data.createSysRole.errors
          } else {
            const data = await gqlFetch<{ updateSysRole: { errors: { message: string }[] | null } }>(UPDATE_ROLE, {
              id: drawer!.row!.id,
              input: values,
            })
            errors = data.updateSysRole.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '角色已创建' : '角色已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'sysRoles'] })
        }}
      />

      <SyniePermissionSheet
        roleId={permRole?.id ?? ''}
        roleName={String(permRole?.name ?? '')}
        isOpen={permRole !== null}
        onOpenChange={(open) => !open && setPermRole(null)}
        readOnly={permReadOnly}
      />
    </>
  )
}
