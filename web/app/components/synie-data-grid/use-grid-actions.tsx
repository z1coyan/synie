import { useState, type ReactNode } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import { useQueryClient } from '@tanstack/react-query'
import type { ResourceBinding } from '~/lib/resources/catalog'
import type { QueryInvalidationAdapter } from '~/lib/resources/catalog/query-cache'
import {
  executeCommandWithInvalidation,
  type ResourceBindingResolver,
} from '~/lib/resources/command-invalidation'
import { resourceBindingFor } from '~/lib/resources/registry'
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

type CommandTarget = GridActionMeta['target']

/**
 * 删除或领域命令执行。
 * - delete：逐条 writer.delete
 * - row：逐条经统一命令失效 interface 传 { id }
 * - bulk / rowOrBulk：一次经统一命令失效 interface 传 { ids }
 * - collection：不传记录 ID
 */
export async function runBindingMutation(
  rows: Row[],
  binding: ResourceBinding,
  actionKey: string,
  target: CommandTarget | 'delete',
  cache: QueryInvalidationAdapter,
  resolveBinding: ResourceBindingResolver = resourceBindingFor,
): Promise<{ ok: number; fail: number; messages: string[] }> {
  const messages: string[] = []

  if (actionKey === 'delete' || target === 'delete') {
    let ok = 0
    let fail = 0
    for (const row of rows) {
      try {
        const del = binding.writer && 'delete' in binding.writer ? binding.writer.delete : undefined
        if (!del) throw new Error(`资源「${binding.resource}」不支持 delete`)
        await del(row.id)
        ok += 1
      } catch (e) {
        fail += 1
        const msg = e instanceof Error ? e.message : String(e)
        if (msg) messages.push(msg)
      }
    }
    return { ok, fail, messages }
  }

  if (!binding.commands) {
    return {
      ok: 0,
      fail: rows.length || 1,
      messages: [`资源「${binding.resource}」未绑定命令「${actionKey}」`],
    }
  }

  if (target === 'row') {
    let ok = 0
    let fail = 0
    for (const row of rows) {
      try {
        await executeCommandWithInvalidation(
          binding,
          actionKey,
          { id: row.id },
          cache,
          resolveBinding,
        )
        ok += 1
      } catch (e) {
        fail += 1
        const msg = e instanceof Error ? e.message : String(e)
        if (msg) messages.push(msg)
      }
    }
    return { ok, fail, messages }
  }

  if (target === 'collection') {
    try {
      await executeCommandWithInvalidation(
        binding,
        actionKey,
        {},
        cache,
        resolveBinding,
      )
      return { ok: 1, fail: 0, messages: [] }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: 0, fail: 1, messages: msg ? [msg] : [] }
    }
  }

  // bulk / rowOrBulk：非空 ids 一次执行
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) {
    return { ok: 0, fail: 1, messages: ['未选择记录'] }
  }
  try {
    await executeCommandWithInvalidation(
      binding,
      actionKey,
      { ids },
      cache,
      resolveBinding,
    )
    return { ok: ids.length, fail: 0, messages: [] }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: 0, fail: ids.length, messages: msg ? [msg] : [] }
  }
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
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [running, setRunning] = useState(false)

  const can = (capability?: string) =>
    !capability || (opts.capabilities ?? meta?.capabilities ?? []).includes(capability)
  const ctx: ActionContext = { refetch }

  const canDelete =
    can('delete') &&
    Boolean(meta?.canDelete) &&
    Boolean(binding.writer && 'delete' in binding.writer && binding.writer.delete)

  const confirmThenMutate =
    (label: string, isDanger: boolean, actionKey: string, target: CommandTarget | 'delete') =>
    (rows: Row[]) =>
      setPending({
        label,
        isDanger,
        rows,
        execute: async (rs) => {
          const { ok, fail, messages } = await runBindingMutation(
            rs,
            binding,
            actionKey,
            target,
            queryClient,
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
      : confirmThenMutate(a.label, a.isDanger, a.key, a.target),
  })

  // 门控用 requiredCapability，不是 command key（setDefault → update）
  const extended = (scope: 'row' | 'bulk') =>
    (meta?.extendedActions ?? [])
      .filter(
        (a) =>
          can(a.requiredCapability) &&
          (a.scope === scope || a.scope === 'both') &&
          // collection 命令不挂在按行选择的菜单上
          !(scope === 'row' && a.target === 'collection') &&
          !(scope === 'bulk' && a.target === 'row'),
      )
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
    // collection 命令进工具栏（如 recalc）
    ...(meta?.extendedActions ?? [])
      .filter((a) => a.target === 'collection' && can(a.requiredCapability))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger,
        mobile: opts.actionMobile?.[a.key],
        run: opts.actionHandlers?.[a.key]
          ? (rows: Row[]) => opts.actionHandlers![a.key](rows, ctx)
          : confirmThenMutate(a.label, a.isDanger, a.key, 'collection'),
      })),
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
      ? [
          {
            key: 'delete',
            label: '删除',
            isDanger: true,
            mobile: mob('delete'),
            run: confirmThenMutate('删除', true, 'delete', 'delete'),
          },
        ]
      : []),
  ]

  const bulkBarActions: ResolvedAction[] = [
    ...(can('batch_print') && opts.onPrintRows
      ? [
          {
            key: 'batch_print',
            label: '批量打印',
            isDanger: false,
            mobile: mob('batch_print'),
            run: (rows: Row[]) => opts.onPrintRows!(rows),
          },
        ]
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
      ? [
          {
            key: 'batch_delete',
            label: '批量删除',
            isDanger: true,
            mobile: mob('batch_delete'),
            run: confirmThenMutate('批量删除', true, 'delete', 'delete'),
          },
        ]
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
                <p>
                  {pending.rows.length > 0
                    ? `将对 ${pending.rows.length} 条记录执行「${pending.label}」,此操作不可撤销。`
                    : `将执行「${pending.label}」,此操作不可撤销。`}
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary" isDisabled={running}>
                  取消
                </Button>
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
