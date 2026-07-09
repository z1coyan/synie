import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Modal, toast } from '@heroui/react'
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

// 用户当前角色/公司关联:limit 200 与 max_page_size 对齐,超出即截断,fail-closed 拒绝编辑
const userJoinsQuery = (userId: string) => {
  const uid = JSON.stringify(userId)
  return `
  query {
    sysUserRoles(filter: { userId: { eq: ${uid} } }, limit: 200, offset: 0) {
      count
      results { id roleId role { name } }
    }
    sysUserCompanies(filter: { userId: { eq: ${uid} } }, limit: 200, offset: 0) {
      count
      results { id companyId company { name } }
    }
  }
`
}
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
const CREATE_USER_COMPANY = `
  mutation ($input: CreateSysUserCompanyInput!) {
    createSysUserCompany(input: $input) { result { id } errors { message } }
  }
`
const DESTROY_USER_COMPANY = `
  mutation ($id: ID!) {
    destroySysUserCompany(id: $id) { errors { message } }
  }
`

/** 一条已存在的关联行:id 是关联表主键,targetId 是角色/公司 id */
type JoinRow = { id: string; targetId: string; name: string }

// ponytail: 逐条并发、聚合报错;量大或需事务性时后端加 bulk action 再切
async function syncJoins(opts: {
  userId: string
  baseline: JoinRow[]
  selected: string[]
  names: Map<string, string>
  createMutation: string
  destroyMutation: string
  createInput: (targetId: string) => Record<string, string>
  kind: string
}): Promise<string[]> {
  const have = new Set(opts.baseline.map((r) => r.targetId))
  const want = new Set(opts.selected)
  const failed: string[] = []
  const nameOf = (id: string) => opts.names.get(id) ?? id.slice(0, 8)
  await Promise.all([
    ...opts.selected
      .filter((t) => !have.has(t))
      .map(async (t) => {
        try {
          const res = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(opts.createMutation, {
            input: { userId: opts.userId, ...opts.createInput(t) },
          })
          if (Object.values(res)[0].errors?.length) failed.push(`${opts.kind}添加失败:${nameOf(t)}`)
        } catch {
          failed.push(`${opts.kind}添加失败:${nameOf(t)}`)
        }
      }),
    ...opts.baseline
      .filter((r) => !want.has(r.targetId))
      .map(async (r) => {
        try {
          const res = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(opts.destroyMutation, {
            id: r.id,
          })
          if (Object.values(res)[0].errors?.length) failed.push(`${opts.kind}移除失败:${nameOf(r.targetId)}`)
        } catch {
          failed.push(`${opts.kind}移除失败:${nameOf(r.targetId)}`)
        }
      }),
  ])
  return failed
}

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
  const [reloadKey, setReloadKey] = useState(0)
  const [myPerms, setMyPerms] = useState<Set<string>>(new Set())
  // 一次性密码:仅存在于本次响应与此弹窗,关闭后无法再次查看
  const [oneTime, setOneTime] = useState<{ username: string; password: string } | null>(null)
  const [resetTarget, setResetTarget] = useState<Row | null>(null)
  const [resetting, setResetting] = useState(false)
  // 角色/公司关联草稿:打开抽屉时装载基线,提交时按选中集 diff 增删
  const [joins, setJoins] = useState<{ roles: JoinRow[]; companies: JoinRow[] } | null>(null)
  const [roleSel, setRoleSel] = useState<string[]>([])
  const [companySel, setCompanySel] = useState<string[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())

  // 重置密码入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  useEffect(() => {
    gqlFetch<{ myPermissions: string[] }>('query { myPermissions }')
      .then((d) => setMyPerms(new Set(d.myPermissions)))
      .catch((e) => toast.danger('权限信息加载失败', { description: (e as Error).message }))
  }, [])

  const canReset = myPerms.has('sys.user:update')

  const mergeNames = (rows: Row[]) =>
    setNames((prev) => {
      const next = new Map(prev)
      for (const r of rows) if (r.name != null) next.set(r.id, String(r.name))
      return next
    })

  // 先拉关联再开抽屉,避免表单已开、回显未到的中间态
  const openDrawer = async (mode: DrawerMode, row: Row | null) => {
    if (mode === 'create' || !row) {
      setJoins({ roles: [], companies: [] })
      setRoleSel([])
      setCompanySel([])
      setNames(new Map())
      setDrawer({ mode: 'create', row: null })
      return
    }
    try {
      const d = await gqlFetch<{
        sysUserRoles: { count: number; results: { id: string; roleId: string; role: { name: string } | null }[] }
        sysUserCompanies: {
          count: number
          results: { id: string; companyId: string; company: { name: string } | null }[]
        }
      }>(userJoinsQuery(String(row.id)))
      // 单页截断时未取回的关联会被当成"未勾选",保存会错误回收,直接拒开
      if (
        d.sysUserRoles.count > d.sysUserRoles.results.length ||
        d.sysUserCompanies.count > d.sysUserCompanies.results.length
      ) {
        toast.danger('用户关联行数超出单页容量(200),请联系开发处理')
        return
      }
      const roles = d.sysUserRoles.results.map((r) => ({
        id: r.id,
        targetId: r.roleId,
        name: r.role?.name ?? r.roleId.slice(0, 8),
      }))
      const companies = d.sysUserCompanies.results.map((c) => ({
        id: c.id,
        targetId: c.companyId,
        name: c.company?.name ?? c.companyId.slice(0, 8),
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
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let userId: string
          if (mode === 'create') {
            const data = await gqlFetch<{ createSysUser: { id: string; username: string; password: string } }>(
              CREATE_USER,
              { username: values.username, name: (values.name as string) || null }
            )
            userId = data.createSysUser.id
            setOneTime({ username: data.createSysUser.username, password: data.createSysUser.password })
          } else {
            const data = await gqlFetch<{ updateSysUser: { errors: { message: string }[] | null } }>(UPDATE_USER, {
              id: drawer!.row!.id,
              input: values,
            })
            const errors = data.updateSysUser.errors
            if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
            userId = String(drawer!.row!.id)
          }
          // 用户已落库,关联同步失败只提示不回滚(重开抽屉可见真实状态,可再改再存)
          const failed = [
            ...(await syncJoins({
              userId,
              baseline: joins?.roles ?? [],
              selected: roleSel,
              names,
              createMutation: CREATE_USER_ROLE,
              destroyMutation: DESTROY_USER_ROLE,
              createInput: (roleId) => ({ roleId }),
              kind: '角色',
            })),
            ...(await syncJoins({
              userId,
              baseline: joins?.companies ?? [],
              selected: companySel,
              names,
              createMutation: CREATE_USER_COMPANY,
              destroyMutation: DESTROY_USER_COMPANY,
              createInput: (companyId) => ({ companyId }),
              kind: '公司',
            })),
          ]
          if (failed.length > 0) {
            toast.danger('角色/公司保存部分失败', { description: failed.join('、') })
          } else {
            toast.success(mode === 'create' ? '用户已创建' : '用户已更新')
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
