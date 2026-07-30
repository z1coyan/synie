import { useState, type ReactNode } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import type { ResourceBinding } from '~/lib/resources/catalog'
import type { ActionContext, BulkAction, GridActionMeta, GridMeta, Row, RowAction } from './types'

export interface ResolvedAction {
  key: string
  label: string
  isDanger: boolean
  /** 卡片模式显隐(见 visibleOnCard);内建动作与 meta 扩展动作不携带,页面自定义动作可声明 */
  mobile?: boolean
  run: (rows: Row[]) => void
}

interface PendingConfirm {
  label: string
  isDanger: boolean
  rows: Row[]
  execute: (rows: Row[]) => Promise<void>
}

/** 逐条执行删除或领域命令（经 ResourceBinding）。 */
async function runIdMutation(
  ids: string[],
  binding: ResourceBinding,
  actionKey: string,
): Promise<{ ok: number; fail: number; messages: string[] }> {
  let ok = 0
  let fail = 0
  const messages: string[] = []
  for (const id of ids) {
    try {
      if (actionKey === 'delete') {
        const del = binding.writer && 'delete' in binding.writer ? binding.writer.delete : undefined
        if (!del) throw new Error(`资源「${binding.resource}」不支持 delete`)
        await del(id)
      } else if (binding.commands) {
        await binding.commands.execute(actionKey, { ids: [id] } as never)
      } else {
        throw new Error(`资源「${binding.resource}」未绑定命令「${actionKey}」`)
      }
      ok += 1
    } catch (e) {
      fail += 1
      const msg = e instanceof Error ? e.message : String(e)
      if (msg) messages.push(msg)
    }
  }
  return { ok, fail, messages }
}

function failureDescription(fail: number, ok: number, messages: string[]): string {
  const unique = [...new Set(messages.map((m) => m.trim()).filter(Boolean))]
  const reasons =
    unique.length === 0
      ? ''
      : unique.length <= 3
        ? unique.join('；')
        : `${unique.slice(0, 3).join('；')}…(共 ${unique.length} 条原因)`
  if (ok === 0 && fail === 1) return reasons || '操作未成功'
  if (ok === 0) return reasons ? `共 ${fail} 条失败: ${reasons}` : `共 ${fail} 条均未执行成功`
  const summary = `成功 ${ok} 条,失败 ${fail} 条`
  return reasons ? `${summary}。${reasons}` : summary
}

export function useGridActions(opts: {
  meta: GridMeta | undefined
  binding: ResourceBinding
  capabilities?: string[]
  refetch: () => void
  clearSelection: () => void
  onView?: (row: Row) => void
  onCreate?: () => void
  createLabel?: string
  onEdit?: (row: Row) => void
  onImport?: (ctx: ActionContext) => void
  onExport?: () => void
  onPrintRows?: (rows: Row[]) => void
  actionHandlers?: Record<string, (rows: Row[], ctx: ActionContext) => void>
  actionVisible?: Record<string, (row: Row) => boolean>
  actionMobile?: Record<string, boolean>
  bulkActions?: BulkAction[]
  rowActions?: RowAction[]
}) {
  const { meta, refetch, clearSelection, binding } = opts
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [running, setRunning] = useState(false)

  const can = (capability?: string) =>
    !capability || (opts.capabilities ?? meta?.capabilities ?? []).includes(capability)
  const ctx: ActionContext = { refetch }

  const canDelete =
    can('delete') &&
    Boolean(meta?.canDelete) &&
    Boolean(binding.writer && 'delete' in binding.writer && binding.writer.delete)

  const confirmThenMutate = (label: string, isDanger: boolean, actionKey: string) => (rows: Row[]) =>
    setPending({
      label,
      isDanger,
      rows,
      execute: async (rs) => {
        const { ok, fail, messages } = await runIdMutation(
          rs.map((r) => r.id),
          binding,
          actionKey,
        )
        if (fail === 0) toast.success(`${label}成功(${ok} 条)`)
        else if (ok === 0)
          toast.danger(`${label}失败`, { description: failureDescription(fail, ok, messages) })
        else
          toast.danger(`${label}部分失败`, {
            description: failureDescription(fail, ok, messages),
          })
        if (ok > 0) {
          refetch()
          clearSelection()
        }
      },
    })

  const extendedAction = (a: GridActionMeta): ResolvedAction => ({
    key: a.key,
    label: a.label,
    isDanger: a.isDanger,
    mobile: opts.actionMobile?.[a.key],
    run: opts.actionHandlers?.[a.key]
      ? (rows) => opts.actionHandlers![a.key](rows, ctx)
      : confirmThenMutate(a.label, a.isDanger, a.key),
  })

  const extended = (scope: 'row' | 'bulk') =>
    (meta?.extendedActions ?? [])
      .filter((a) => can(a.key) && (a.scope === scope || a.scope === 'both'))
      .map(extendedAction)

  const mob = (key: string) => opts.actionMobile?.[key]
  const toolbarActions: ResolvedAction[] = [
    ...(can('import') && opts.onImport
      ? [{ key: 'import', label: '导入', isDanger: false, mobile: mob('import'), run: () => opts.onImport!(ctx) }]
      : []),
    ...(can('create') && opts.onCreate
      ? [{ key: 'create', label: opts.createLabel ?? '新增', isDanger: false, mobile: mob('create'), run: () => opts.onCreate!() }]
      : []),
    ...(can('export') && opts.onExport
      ? [{ key: 'export', label: '导出', isDanger: false, mobile: mob('export'), run: () => opts.onExport!() }]
      : []),
  ]

  const vis = (key: string, row: Row) => opts.actionVisible?.[key]?.(row) ?? true
  const rowMenuFor = (row: Row): ResolvedAction[] => [
    ...(opts.onView
      ? [{ key: 'view', label: '查看', isDanger: false, mobile: mob('view'), run: () => opts.onView!(row) }]
      : []),
    ...(can('update') && opts.onEdit && vis('edit', row)
      ? [{ key: 'edit', label: '编辑', isDanger: false, mobile: mob('edit'), run: () => opts.onEdit!(row) }]
      : []),
    ...(can('print') && opts.onPrintRows
      ? [{ key: 'print', label: '打印', isDanger: false, mobile: mob('print'), run: () => opts.onPrintRows!([row]) }]
      : []),
    ...extended('row').filter((a) => vis(a.key, row)),
    ...(opts.rowActions ?? [])
      .filter((a) => can(a.capability) && vis(a.key, row))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger ?? false,
        mobile: a.mobile,
        run: () => a.onAction(row, ctx),
      })),
    ...(canDelete && vis('delete', row)
      ? [{ key: 'delete', label: '删除', isDanger: true, mobile: mob('delete'), run: confirmThenMutate('删除', true, 'delete') }]
      : []),
  ]

  const bulkBarActions: ResolvedAction[] = [
    ...(can('batch_print') && opts.onPrintRows
      ? [{ key: 'batch_print', label: '批量打印', isDanger: false, mobile: mob('batch_print'), run: (rows: Row[]) => opts.onPrintRows!(rows) }]
      : []),
    ...extended('bulk'),
    ...(opts.bulkActions ?? [])
      .filter((a) => can(a.capability))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger ?? false,
        mobile: a.mobile,
        run: (rows: Row[]) => a.onAction(rows, ctx),
      })),
    ...(can('batch_delete') && canDelete
      ? [{ key: 'batch_delete', label: '批量删除', isDanger: true, mobile: mob('batch_delete'), run: confirmThenMutate('批量删除', true, 'delete') }]
      : []),
  ]

  const confirmDialog: ReactNode = (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialog.Container>
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
