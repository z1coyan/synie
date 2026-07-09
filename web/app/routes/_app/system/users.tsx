import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Modal, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteMultiSelect } from '~/components/synie-remote-select/RemoteMultiSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/users')({
  component: UsersPage,
})

// 创建/重置走手写 mutation:明文密码只随这次响应返回,后端只存哈希
const CREATE_USER = `
  mutation ($username: String!, $name: String) {
    createSysUser(username: $username, name: $name) { id username password }
  }
`
const UPDATE_USER = `
  mutation ($id: ID!, $input: UpdateSysUserInput!) {
    updateSysUser(id: $id, input: $input) { result { id } errors { message } }
  }
`
const RESET_PASSWORD = `
  mutation ($id: ID!) {
    resetSysUserPassword(id: $id) { password }
  }
`
// 用户已授角色:limit 200 与 max_page_size 对齐,超出即截断,fail-closed 拒绝编辑(同 PermissionSheet)
const userRolesQuery = (userId: string) => `
  query {
    sysUserRoles(filter: { userId: { eq: ${JSON.stringify(userId)} } }, limit: 200, offset: 0) {
      count
      results { id roleId role { name } }
    }
  }
`
const CREATE_USER_ROLE = `
  mutation ($input: CreateSysUserRoleInput!) {
    createSysUserRole(input: $input) { result { id } errors { message } }
  }
`
const DESTROY_USER_ROLE = `
  mutation ($id: ID!) {
    destroySysUserRole(id: $id) { errors { message } }
  }
`

// ponytail: execCommand 已废弃,但 HTTP 环境(如 Tailscale IP 访问)下 clipboard API 不可用,只有这条路
function legacyCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('execCommand copy failed')
}

// 分配角色弹窗:打开拉当前授权回显,保存按勾选 diff 逐条增删 sys_user_role
function AssignRolesModal(props: { user: Row | null; canWrite: boolean; onClose: () => void }) {
  const { user, canWrite, onClose } = props
  const [loaded, setLoaded] = useState<{ userId: string; rows: { id: string; roleId: string }[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // 关闭动画期间父级已把 user 置空,标题读最后一次打开的快照(同 PermissionSheet 的 lastOpenRef 模式)
  const lastUserRef = useRef(user)
  if (user) lastUserRef.current = user
  const display = user ?? lastUserRef.current

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoaded(null)
    setError(null)
    gqlFetch<{
      sysUserRoles: { count: number; results: { id: string; roleId: string; role: { name: string } | null }[] }
    }>(userRolesQuery(String(user.id)))
      .then((res) => {
        if (cancelled) return
        const { count, results } = res.sysUserRoles
        // 单页截断时未取回的授权行会被当成"未勾选",保存会错误回收,直接拒绝编辑
        if (count > results.length) {
          setError('角色行数超出单页容量(200),请联系开发处理')
          return
        }
        setLoaded({ userId: String(user.id), rows: results.map(({ id, roleId }) => ({ id, roleId })) })
        setSelected(results.map((r) => r.roleId))
        setNames(new Map(results.map((r) => [r.roleId, r.role?.name ?? r.roleId.slice(0, 8)])))
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [user, reloadKey])

  // 换用户时上一个用户的数据还没被 effect 清掉的那一帧,当未加载走 Spinner(同 PermissionSheet)
  const ready = loaded && user && loaded.userId === String(user.id) ? loaded : null

  const save = async () => {
    if (!user || !ready) return
    const have = new Map(ready.rows.map((r) => [r.roleId, r.id]))
    const want = new Set(selected)
    const toCreate = selected.filter((roleId) => !have.has(roleId))
    const toDestroy = ready.rows.filter((r) => !want.has(r.roleId))
    if (toCreate.length === 0 && toDestroy.length === 0) {
      onClose()
      return
    }
    setSaving(true)
    const failed: string[] = []
    const nameOf = (roleId: string) => names.get(roleId) ?? roleId.slice(0, 8)
    // ponytail: 前端逐条并发、聚合报错,同 PermissionSheet;量大或需事务性时后端加 bulk action 再切
    await Promise.all([
      ...toCreate.map(async (roleId) => {
        try {
          const res = await gqlFetch<{ createSysUserRole: { errors: { message: string }[] | null } }>(
            CREATE_USER_ROLE,
            { input: { userId: user.id, roleId } }
          )
          if (res.createSysUserRole.errors?.length) failed.push(`添加失败:${nameOf(roleId)}`)
        } catch {
          failed.push(`添加失败:${nameOf(roleId)}`)
        }
      }),
      ...toDestroy.map(async (r) => {
        try {
          const res = await gqlFetch<{ destroySysUserRole: { errors: { message: string }[] | null } }>(
            DESTROY_USER_ROLE,
            { id: r.id }
          )
          if (res.destroySysUserRole.errors?.length) failed.push(`移除失败:${nameOf(r.roleId)}`)
        } catch {
          failed.push(`移除失败:${nameOf(r.roleId)}`)
        }
      }),
    ])
    setSaving(false)
    if (failed.length > 0) {
      toast.danger('角色保存部分失败', { description: failed.join('、') })
      setReloadKey((k) => k + 1) // 重拉真实授权态,弹窗不关
    } else {
      toast.success('角色已保存')
      onClose()
    }
  }

  return (
    <Modal.Backdrop isOpen={user !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>分配角色:{String(display?.username ?? '')}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {error ? (
              <div className="flex items-center gap-3">
                <p className="flex-1 text-sm text-danger">{error}</p>
                <Button size="sm" variant="secondary" onPress={() => setReloadKey((k) => k + 1)}>
                  重试
                </Button>
              </div>
            ) : !ready ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : (
              <>
                <RemoteMultiSelect
                  resource="sysRoles"
                  label="角色"
                  placeholder="搜索并选择角色…"
                  value={selected}
                  isDisabled={!canWrite || saving}
                  onChange={(ids, rows) => {
                    setSelected(ids)
                    setNames((prev) => {
                      const next = new Map(prev)
                      for (const r of rows) if (r.name != null) next.set(r.id, String(r.name))
                      return next
                    })
                  }}
                />
                {!canWrite && <p className="mt-2 text-xs text-ink-500">当前账号无角色分配写权限,仅可查看。</p>}
              </>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={onClose}>
              取消
            </Button>
            {canWrite && (
              <Button isPending={saving} isDisabled={!ready} onPress={save}>
                保存
              </Button>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function UsersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [myPerms, setMyPerms] = useState<Set<string>>(new Set())
  // 一次性密码:仅存在于本次响应与此弹窗,关闭后无法再次查看
  const [oneTime, setOneTime] = useState<{ username: string; password: string } | null>(null)
  const [resetTarget, setResetTarget] = useState<Row | null>(null)
  const [resetting, setResetting] = useState(false)
  const [roleTarget, setRoleTarget] = useState<Row | null>(null)

  // 重置密码入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  useEffect(() => {
    gqlFetch<{ myPermissions: string[] }>('query { myPermissions }')
      .then((d) => setMyPerms(new Set(d.myPermissions)))
      .catch((e) => toast.danger('权限信息加载失败', { description: (e as Error).message }))
  }, [])

  const canReset = myPerms.has('sys.user:update')
  const canViewRoles = myPerms.has('sys.user_role:read')
  const canWriteRoles = myPerms.has('sys.user_role:create') && myPerms.has('sys.user_role:delete')

  const doReset = async () => {
    if (!resetTarget) return
    setResetting(true)
    try {
      const d = await gqlFetch<{ resetSysUserPassword: { password: string } }>(RESET_PASSWORD, {
        id: resetTarget.id,
      })
      setOneTime({ username: String(resetTarget.username ?? ''), password: d.resetSysUserPassword.password })
      setResetTarget(null)
      toast.success('密码已重置')
    } catch (e) {
      toast.danger('重置密码失败', { description: (e as Error).message })
    } finally {
      setResetting(false)
    }
  }

  const copyPassword = async () => {
    if (!oneTime) return
    try {
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(oneTime.password)
      } else {
        legacyCopy(oneTime.password)
      }
      toast.success('已复制到剪贴板')
    } catch {
      toast.danger('复制失败,请手动选中密码复制')
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">用户管理</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统登录用户。密码由系统随机生成,仅在创建或重置时显示一次。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysUsers"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={
            canViewRoles || canReset
              ? [
                  ...(canViewRoles
                    ? [{ key: 'assign-roles', label: '分配角色', onAction: (row: Row) => setRoleTarget(row) }]
                    : []),
                  ...(canReset
                    ? [{ key: 'reset-password', label: '重置密码', onAction: (row: Row) => setResetTarget(row) }]
                    : []),
                ]
              : undefined
          }
        />
      </div>

      <SynieRecordDrawer
        resource="sysUsers"
        label="用户"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          username: { required: true, edit: 'createOnly', placeholder: '如 zhangsan' },
          name: { placeholder: '如 张三' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{ createSysUser: { username: string; password: string } }>(CREATE_USER, {
              username: values.username,
              name: (values.name as string) || null,
            })
            toast.success('用户已创建')
            setOneTime({ username: data.createSysUser.username, password: data.createSysUser.password })
          } else {
            const data = await gqlFetch<{ updateSysUser: { errors: { message: string }[] | null } }>(UPDATE_USER, {
              id: drawer!.row!.id,
              input: values,
            })
            const errors = data.updateSysUser.errors
            if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
            toast.success('用户已更新')
          }
          setReloadKey((k) => k + 1)
        }}
      />

      {/* 分配角色 */}
      <AssignRolesModal user={roleTarget} canWrite={canWriteRoles} onClose={() => setRoleTarget(null)} />

      {/* 重置确认 */}
      <Modal.Backdrop isOpen={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>重置密码</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm">
                将为用户 <span className="font-medium">{String(resetTarget?.username ?? '')}</span>{' '}
                生成新的随机密码,原密码立即失效。是否继续?
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setResetTarget(null)}>
                取消
              </Button>
              <Button isPending={resetting} onPress={doReset}>
                确认重置
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* 一次性密码展示:关闭即丢弃,无任何地方可再查 */}
      <Modal.Backdrop isOpen={oneTime !== null} onOpenChange={(open) => !open && setOneTime(null)}>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>一次性密码</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm">
                用户 <span className="font-medium">{oneTime?.username}</span> 的密码已生成。
                <span className="text-danger">密码仅显示这一次</span>,关闭后无法再次查看,请立即复制并妥善保存。
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 rounded-md border border-ink-900/10 bg-ink-900/5 px-3 py-2 font-mono text-base tracking-wide select-all">
                  {oneTime?.password}
                </code>
                <Button variant="secondary" onPress={copyPassword}>
                  复制
                </Button>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button onPress={() => setOneTime(null)}>我已保存密码</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
