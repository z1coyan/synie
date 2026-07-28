import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Modal, toast } from '@heroui/react'
import { fetchMe } from '~/lib/api/session'
import { createUser, fetchUserAccess, resetUserPassword, roleClient, userClient } from '~/lib/resources/iam'
import { companyClient } from '~/lib/resources/companies'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteMultiSelect } from '~/components/synie-remote-select/RemoteMultiSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/users')({
  component: UsersPage,
})

/** 一条已存在的关联行:id 是关联表主键,targetId 是角色/公司 id */
type JoinRow = { id: string; targetId: string; name: string }

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

/** view 态的关联展示:与 ViewField 同一套样式 */
function JoinText({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{label}</span>
      <div className="text-sm">{items.length > 0 ? items.join('、') : <span className="text-muted">—</span>}</div>
    </div>
  )
}

function UsersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const [myPerms, setMyPerms] = useState<Set<string>>(new Set())
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  // 一次性密码:仅存在于本次响应与此弹窗,关闭后无法再次查看
  const [oneTime, setOneTime] = useState<{ username: string; password: string } | null>(null)
  const [resetTarget, setResetTarget] = useState<Row | null>(null)
  const [resetting, setResetting] = useState(false)
  // 角色/公司关联草稿:打开抽屉时装载基线,提交时按选中集 diff 增删
  const [joins, setJoins] = useState<{ roles: JoinRow[]; companies: JoinRow[] } | null>(null)
  const [roleSel, setRoleSel] = useState<string[]>([])
  const [companySel, setCompanySel] = useState<string[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  // 请求守卫:每次开抽屉自增,await 回来后比对最新序号——防止先发的慢请求(A)覆盖已切到 B 的关联/勾选
  const reqIdRef = useRef(0)

  // 重置密码入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  useEffect(() => {
    fetchMe()
      .then((d) => {
        setMyPerms(new Set(d.permissions))
        setIsSuperAdmin(d.superAdmin)
      })
      .catch((e) => toast.danger('权限信息加载失败', { description: (e as Error).message }))
  }, [])

  const canReset = isSuperAdmin || myPerms.has('sys.user:update')

  const mergeNames = (rows: Row[]) =>
    setNames((prev) => {
      const next = new Map(prev)
      for (const r of rows) if (r.name != null) next.set(r.id, String(r.name))
      return next
    })

  // 先拉关联再开抽屉,避免表单已开、回显未到的中间态
  const openDrawer = async (mode: DrawerMode, row: Row | null) => {
    // 每次开抽屉先占号:create 同步回填也占号,作废上一张单据可能还在途的慢请求
    const my = ++reqIdRef.current
    if (mode === 'create' || !row) {
      setJoins({ roles: [], companies: [] })
      setRoleSel([])
      setCompanySel([])
      setNames(new Map())
      setDrawer({ mode: 'create', row: null })
      return
    }
    try {
      const d = await fetchUserAccess(String(row.id))
      // 抽屉已切走(开了别的单据/关了):丢弃过期响应,不写 joins/勾选,避免覆盖当前单据
      if (my !== reqIdRef.current) return
      const roles = d.roles.map((r) => ({
        id: r.id,
        targetId: r.id,
        name: r.name,
      }))
      const companies = d.companies.map((c) => ({
        id: c.id,
        targetId: c.id,
        name: c.name,
      }))
      setJoins({ roles, companies })
      setRoleSel(roles.map((r) => r.targetId))
      setCompanySel(companies.map((c) => c.targetId))
      setNames(new Map([...roles, ...companies].map((r) => [r.targetId, r.name])))
      setDrawer({ mode, row })
    } catch (e) {
      toast.danger('用户角色/公司加载失败', { description: (e as Error).message })
    }
  }

  const doReset = async () => {
    if (!resetTarget) return
    setResetting(true)
    try {
      const d = await resetUserPassword(resetTarget.id)
      setOneTime({ username: String(resetTarget.username ?? ''), password: d.password })
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
          resource="sysUsers"
          client={userClient}
          onView={(row) => void openDrawer('view', row)}
          onCreate={() => void openDrawer('create', null)}
          onEdit={(row) => void openDrawer('edit', row)}
          rowActions={
            canReset
              ? [{ key: 'reset-password', label: '重置密码', onAction: (row) => setResetTarget(row) }]
              : undefined
          }
        />
      </div>

      <SynieRecordDrawer
        resource="sysUsers"
        client={userClient}
        label="用户"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          username: { required: true, edit: 'createOnly', placeholder: '如 zhangsan' },
          name: { placeholder: '如 张三' },
        }}
        extraContent={(mode) =>
          joins && (
            <div className="grid grid-cols-1 gap-4">
              {mode === 'view' ? (
                <>
                  <JoinText label="角色" items={joins.roles.map((r) => r.name)} />
                  <JoinText label="可访问公司" items={joins.companies.map((c) => c.name)} />
                </>
              ) : (
                <>
                  <RemoteMultiSelect
                    resource="sysRoles"
                    client={roleClient}
                    label="角色"
                    placeholder="搜索并选择角色…"
                    value={roleSel}
                    initialRows={joins.roles.map((r) => ({ id: r.targetId, name: r.name }))}
                    onChange={(ids, rows) => {
                      setRoleSel(ids)
                      mergeNames(rows)
                    }}
                  />
                  <RemoteMultiSelect
                    resource="basCompanies"
                    client={companyClient}
                    label="可访问公司"
                    placeholder="搜索并选择公司…"
                    value={companySel}
                    initialRows={joins.companies.map((c) => ({ id: c.targetId, name: c.name }))}
                    onChange={(ids, rows) => {
                      setCompanySel(ids)
                      mergeNames(rows)
                    }}
                  />
                </>
              )}
            </div>
          )
        }
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await createUser({
              username: String(values.username),
              name: (values.name as string) || null,
              roleIds: roleSel,
              companyIds: companySel,
            })
            setOneTime({
              username: String(data.user.username),
              password: String(data.password ?? ''),
            })
          } else {
            await userClient.update(drawer!.row!.id, {
              name: (values.name as string) || null,
              roleIds: roleSel,
              companyIds: companySel,
            })
          }
          toast.success(mode === 'create' ? '用户已创建' : '用户已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', userClient.id, 'sysUsers'] })
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
