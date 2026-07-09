import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Modal, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
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

function UsersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [myPerms, setMyPerms] = useState<Set<string>>(new Set())
  // 一次性密码:仅存在于本次响应与此弹窗,关闭后无法再次查看
  const [oneTime, setOneTime] = useState<{ username: string; password: string } | null>(null)
  const [resetTarget, setResetTarget] = useState<Row | null>(null)
  const [resetting, setResetting] = useState(false)

  // 重置密码入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  useEffect(() => {
    gqlFetch<{ myPermissions: string[] }>('query { myPermissions }')
      .then((d) => setMyPerms(new Set(d.myPermissions)))
      .catch((e) => toast.danger('权限信息加载失败', { description: (e as Error).message }))
  }, [])

  const canReset = myPerms.has('sys.user:update')

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
            canReset
              ? [{ key: 'reset-password', label: '重置密码', onAction: (row) => setResetTarget(row) }]
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
