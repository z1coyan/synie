import { useState, type ReactNode } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import type { ActionContext, BulkAction, GridActionMeta, GridMeta, Row, RowAction } from './types'

export interface ResolvedAction {
  key: string
  label: string
  isDanger: boolean
  run: (rows: Row[]) => void
}

interface PendingConfirm {
  label: string
  isDanger: boolean
  rows: Row[]
  execute: (rows: Row[]) => Promise<void>
}

/** 逐条执行仅吃 id 的 mutation(destroy/扩展工作流动作)。 */
// ponytail: 前端逐条循环,量大或需事务性时后端加 Ash bulk action 再切
async function runIdMutation(mutation: string, ids: string[]): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  for (const id of ids) {
    try {
      const data = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(
        `mutation ($id: ID!) { ${mutation}(id: $id) { errors { message } } }`,
        { id }
      )
      const errors = data[mutation]?.errors
      if (errors && errors.length > 0) fail += 1
      else ok += 1
    } catch {
      fail += 1
    }
  }
  return { ok, fail }
}

export function useGridActions(opts: {
  meta: GridMeta | undefined
  /** 覆盖 meta.capabilities(资源复用他人权限码、meta 为空时页面显式声明);不传用 meta 下发值 */
  capabilities?: string[]
  refetch: () => void
  clearSelection: () => void
  onView?: (row: Row) => void
  onCreate?: () => void
  /** 「新增」按钮文案覆盖(如固定动线的「新增承兑接收」) */
  createLabel?: string
  onEdit?: (row: Row) => void
  onImport?: (ctx: ActionContext) => void
  onExport?: () => void
  onPrintRows?: (rows: Row[]) => void
  actionHandlers?: Record<string, (rows: Row[], ctx: ActionContext) => void>
  /** 按行显隐动作:key 为扩展动作 key 或内建 'edit'/'delete',返回 false 该行菜单不含此动作(如仅草稿可删) */
  actionVisible?: Record<string, (row: Row) => boolean>
  bulkActions?: BulkAction[]
  rowActions?: RowAction[]
}) {
  const { meta, refetch, clearSelection } = opts
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [running, setRunning] = useState(false)

  const can = (capability?: string) =>
    !capability || (opts.capabilities ?? meta?.capabilities ?? []).includes(capability)
  const ctx: ActionContext = { refetch }

  const confirmThenMutate = (label: string, isDanger: boolean, mutation: string) => (rows: Row[]) =>
    setPending({
      label,
      isDanger,
      rows,
      execute: async (rs) => {
        const { ok, fail } = await runIdMutation(mutation, rs.map((r) => r.id))
        // 三分支:全部成功 / 整批失败(下方 ok>0 门控自然不 refetch)/ 部分失败
        if (fail === 0) toast.success(`${label}成功(${ok} 条)`)
        else if (ok === 0) toast.danger(`${label}失败`, { description: `共 ${fail} 条均未执行成功` })
        else toast.danger(`${label}部分失败`, { description: `成功 ${ok} 条,失败 ${fail} 条` })
        if (ok > 0) {
          refetch()
          clearSelection()
        }
      },
    })

  // 扩展动作:默认内建确认+mutation,actionHandlers[key] 覆盖
  const extendedAction = (a: GridActionMeta): ResolvedAction => ({
    key: a.key,
    label: a.label,
    isDanger: a.isDanger,
    run: opts.actionHandlers?.[a.key]
      ? (rows) => opts.actionHandlers![a.key](rows, ctx)
      : confirmThenMutate(a.label, a.isDanger, a.mutation),
  })

  const extended = (scope: 'row' | 'bulk') =>
    (meta?.extendedActions ?? [])
      .filter((a) => can(a.key) && (a.scope === scope || a.scope === 'both'))
      .map(extendedAction)

  // 工具栏:导入/新增/导出(print 由行内与批量承载);导入在新增左侧(流水导入产品要求)
  const toolbarActions: ResolvedAction[] = [
    ...(can('import') && opts.onImport
      ? [{ key: 'import', label: '导入', isDanger: false, run: () => opts.onImport!(ctx) }]
      : []),
    ...(can('create') && opts.onCreate
      ? [{ key: 'create', label: opts.createLabel ?? '新增', isDanger: false, run: () => opts.onCreate!() }]
      : []),
    ...(can('export') && opts.onExport
      ? [{ key: 'export', label: '导出', isDanger: false, run: () => opts.onExport!() }]
      : []),
  ]

  // 行内菜单(actionVisible 按行过滤:状态机类页面仅特定状态放行审核/删除等)
  const vis = (key: string, row: Row) => opts.actionVisible?.[key]?.(row) ?? true
  const rowMenuFor = (row: Row): ResolvedAction[] => [
    ...(opts.onView
      ? [{ key: 'view', label: '查看', isDanger: false, run: () => opts.onView!(row) }]
      : []),
    ...(can('update') && opts.onEdit && vis('edit', row)
      ? [{ key: 'edit', label: '编辑', isDanger: false, run: () => opts.onEdit!(row) }]
      : []),
    ...(can('print') && opts.onPrintRows
      ? [{ key: 'print', label: '打印', isDanger: false, run: () => opts.onPrintRows!([row]) }]
      : []),
    ...extended('row').filter((a) => vis(a.key, row)),
    ...(opts.rowActions ?? [])
      .filter((a) => can(a.capability))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger ?? false,
        run: () => a.onAction(row, ctx),
      })),
    ...(can('delete') && meta?.destroyMutation && vis('delete', row)
      ? [{ key: 'delete', label: '删除', isDanger: true, run: confirmThenMutate('删除', true, meta.destroyMutation) }]
      : []),
  ]

  // 批量条
  const bulkBarActions: ResolvedAction[] = [
    ...(can('batch_print') && opts.onPrintRows
      ? [{ key: 'batch_print', label: '批量打印', isDanger: false, run: (rows: Row[]) => opts.onPrintRows!(rows) }]
      : []),
    ...extended('bulk'),
    ...(opts.bulkActions ?? [])
      .filter((a) => can(a.capability))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger ?? false,
        run: (rows: Row[]) => a.onAction(rows, ctx),
      })),
    // 批量码叠加在基础码之上:服务端逐条按 delete 校验,只授 batch_delete 不授 delete 会全拒
    ...(can('batch_delete') && can('delete') && meta?.destroyMutation
      ? [{ key: 'batch_delete', label: '批量删除', isDanger: true, run: confirmThenMutate('批量删除', true, meta.destroyMutation) }]
      : []),
  ]

  // 渲染为已成型元素而非组件函数:若写成 `const ConfirmDialog = () => (...)` 再 `<actions.ConfirmDialog />`,
  // 每次渲染都产生新的组件类型,导致弹窗子树整体卸载重建(交互中焦点丢失、退出动画失效)。
  const confirmDialog: ReactNode = (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialog.Container>
        {/* 退场动画期间 pending 已清空、Heading 不在,显式 aria-label 防 RAC 无标题警告 */}
        <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label={pending ? `确认${pending.label}` : '操作确认'}>
          {pending && (
            <>
              <AlertDialog.Header>
                <AlertDialog.Icon status={pending.isDanger ? 'danger' : 'accent'} />
                <AlertDialog.Heading>确认{pending.label}?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>将对 {pending.rows.length} 条记录执行「{pending.label}」,此操作不可撤销。</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary" isDisabled={running}>取消</Button>
                <Button
                  variant={pending.isDanger ? 'danger' : 'primary'}
                  isPending={running}
                  onPress={async () => {
                    setRunning(true)
                    try {
                      await pending.execute(pending.rows)
                    } finally {
                      setRunning(false)
                      setPending(null)
                    }
                  }}
                >
                  确认
                </Button>
              </AlertDialog.Footer>
            </>
          )}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  return { toolbarActions, rowMenuFor, bulkBarActions, confirmDialog }
}
