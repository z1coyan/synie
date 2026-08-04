import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Modal, toast } from '@heroui/react'
import { createUser, fetchUserAccess, resetUserPassword, userClient } from '~/lib/resources/iam'
import { toastError } from '~/lib/toast'
import { useMyPerms } from '~/lib/use-my-perms'
import { useRequestGuard } from '~/lib/use-request-guard'
import { useCatalogBasicForm } from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteMultiSelect } from '~/components/synie-remote-select/RemoteMultiSelect'
import type { Row } from '~/components/synie-data-grid/types'

const RESOURCE = 'sysUsers'

export const Route = createFileRoute('/_app/system/users')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
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
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const userForm = useCatalogBasicForm(RESOURCE, '用户')
  // 重置密码入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  const { myPerms, isSuperAdmin } = useMyPerms()
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
  const guard = useRequestGuard()

  const canReset = isSuperAdmin || myPerms.has('sys.user:update')

  const mergeNames = (rows: Row[]) =>
    setNames((prev) => {
      const next = new Map(prev)
      for (const r of rows) if (r.name != null) next.set(r.id, String(r.name))
      return next
    })

  // 深链/点击开抽屉:按 recordId 拉角色与公司;create 清空;关抽屉清空
  useEffect(() => {
    const my = guard.begin()
    if (!drawer) {
      setJoins(null)
      setRoleSel([])
      setCompanySel([])
      setNames(new Map())
      return
    }
    if (drawer.mode === 'create' || drawer.recordId == null) {
      setJoins({ roles: [], companies: [] })
      setRoleSel([])
      setCompanySel([])
      setNames(new Map())
      return
    }
    void fetchUserAccess(drawer.recordId)
      .then((d) => {
        if (!guard.isCurrent(my)) return
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
      })
      .catch((e) => {
        if (!guard.isCurrent(my)) return
        toastError('用户角色/公司加载失败')(e)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅抽屉身份变化时响应
  }, [drawer?.recordId, drawer?.mode])

  const doReset = async () => {
    if (!resetTarget) return
    setResetting(true)
    try {
      const d = await resetUserPassword(resetTarget.id)
      setOneTime({ username: String(resetTarget.username ?? ''), password: d.password })
      setResetTarget(null)
      toast.success('密码已重置')
    } catch (e) {
      toastError('重置密码失败')(e)
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
      <p className="mt-2 text-sm text-ink-500">
        管理系统登录用户。密码由系统随机生成,仅在创建或重置时显示一次。邮箱用于 Logto
        登录匹配(与 Logto 账号邮箱一致时方可首登绑定)。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          rowActions={
            canReset
              ? [{ key: 'reset-password', label: '重置密码', onAction: (row) => setResetTarget(row) }]
              : undefined
          }
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={userForm.formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        exclude={userForm.formProps.exclude}
        // username/name 的 required/edit/placeholder 由 Catalog Basic Form 投影；
        // 角色/公司 multi-select 为 Presentation Extension（extraContent）
        fields={userForm.formProps.fields}
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
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          const emailRaw = values.email
          const email =
            emailRaw === undefined || emailRaw === null || String(emailRaw).trim() === ''
              ? null
              : String(emailRaw).trim()
          if (mode === 'create') {
            const data = await createUser({
              username: String(values.username),
              name: (values.name as string) || null,
              email,
              roleIds: roleSel,
              companyIds: companySel,
            })
            setOneTime({
              username: String(data.user.username),
              password: String(data.password ?? ''),
            })
          } else {
            await userClient.update(String(drawer!.recordId), {
              name: (values.name as string) || null,
              email,
              roleIds: roleSel,
              companyIds: companySel,
            })
          }
          toast.success(mode === 'create' ? '用户已创建' : '用户已更新')
          await userForm.binding.cache.invalidateGrid(queryClient)
        }}
      />

      {/* 重置确认 */}
      <Modal.Backdrop isOpen={resetTarget !== null} onOpenChange={(isOpen) => !isOpen && setResetTarget(null)}>
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
      <Modal.Backdrop isOpen={oneTime !== null} onOpenChange={(isOpen) => !isOpen && setOneTime(null)}>
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
