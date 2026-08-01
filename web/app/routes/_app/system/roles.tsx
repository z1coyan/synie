import { useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Chip, toast } from '@heroui/react'
import { useResourceBinding } from '~/lib/resources/resource-context'
import { useCurrentActor } from '~/lib/actor-context'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { createSystemPresentation } from '~/lib/resources/presentation/system-presentations'
import type { CatalogGroup, GrantedRow } from '~/components/synie-permission-sheet/matrix'
import { SyniePermissionSheet } from '~/components/synie-permission-sheet/SyniePermissionSheet'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/roles')({
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
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const [permRole, setPermRole] = useState<Row | null>(null)
  const actor = useCurrentActor()
  const myPerms = new Set(actor.permissions)
  const isSuperAdmin = actor.superAdmin
  const binding = useResourceBinding('sysRoles')
  const presentation = createSystemPresentation(binding)
  const permissionAdapter = useMemo(() => binding.commands ? ({
    async load(roleId: string) {
      const value = await binding.commands!.execute('loadPermissions', { id: roleId }) as {
        catalog: { groups: CatalogGroup[] }
        rows: GrantedRow[]
      }
      return { catalog: value.catalog.groups, rows: value.rows }
    },
    sync(roleId: string, permissions: string[]) {
      return binding.commands!.execute('syncPermissions', { id: roleId, permissions })
    },
  }) : undefined, [binding])

  const canConfigure = isSuperAdmin || myPerms.has('sys.role_permission:read')
  const canWrite = isSuperAdmin || (myPerms.has('sys.role_permission:create') && myPerms.has('sys.role_permission:delete'))

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
            ...statusToggleActions({
              field: 'enabled',
              update: (id, input) => {
                if (!binding.writer || !('update' in binding.writer) || !binding.writer.update) throw new Error('角色不支持 update')
                return binding.writer.update(id, input)
              },
              onDone: () =>
                binding.cache.invalidateGrid(queryClient),
            }),
          ]}
        />
      </div>

      <SynieRecordDrawer
        resource="sysRoles"
        label={presentation.label}
        exclude={presentation.exclude}
        fields={presentation.fields}
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
          if (!binding.writer) throw new Error('角色不支持写入')
          if (mode === 'create') {
            if (!('create' in binding.writer) || !binding.writer.create) throw new Error('角色不支持 create')
            await binding.writer.create(values)
          } else {
            if (!('update' in binding.writer) || !binding.writer.update) throw new Error('角色不支持 update')
            await binding.writer.update(String(drawer!.row!.id), values)
          }
          toast.success(mode === 'create' ? '角色已创建' : '角色已更新')
          await binding.cache.invalidateGrid(queryClient)
        }}
      />

      <SyniePermissionSheet
        roleId={permRole?.id ?? ''}
        roleName={String(permRole?.name ?? '')}
        isOpen={permRole !== null}
        onOpenChange={(open) => !open && setPermRole(null)}
        readOnly={permReadOnly}
        adapter={permissionAdapter}
      />
    </>
  )
}
