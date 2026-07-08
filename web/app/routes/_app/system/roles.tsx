import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'

export const Route = createFileRoute('/_app/system/roles')({
  component: RolesPage,
})

function RolesPage() {
  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>
      <div className="mt-6">
        <SynieDataGrid resource="sysRoles" />
      </div>
    </>
  )
}
