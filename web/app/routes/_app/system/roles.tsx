import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
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

function RolesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
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

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysRoles"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={
            canConfigure
              ? [{ key: 'permissions', label: '配置权限', onAction: (row) => setPermRole(row) }]
              : undefined
          }
        />
      </div>

      <SynieRecordDrawer
        resource="sysRoles"
        label="角色"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '如 purchaser' },
          name: { required: true, placeholder: '如 采购管理员' },
          enabled: { defaultValue: true },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
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
          setReloadKey((k) => k + 1) // 触发 SynieDataGrid 重挂载刷新(跟进项:第二个使用页出现时暴露 refetch)
        }}
      />

      <SyniePermissionSheet
        roleId={permRole?.id ?? ''}
        roleName={String(permRole?.name ?? '')}
        isOpen={permRole !== null}
        onOpenChange={(open) => !open && setPermRole(null)}
        readOnly={!canWrite}
      />
    </>
  )
}
