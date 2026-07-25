import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Chip, Dropdown, Label, toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import {
  dismissTodo,
  fetchTodos,
  fetchUnreadCount,
  formatTodoTime,
  markTodoRead,
  todoSourcePath,
  todoTypeLabel,
  type SysTodo,
} from '~/lib/todo'
import { IconBell } from '~/components/icons'

const UNREAD_KEY = ['sysTodoUnreadCount'] as const
const RECENT_KEY = ['sysTodos', 'recent'] as const

/**
 * 顶栏铃铛:未读徽标 + 下拉最近待办 + 「查看全部」。
 * 刷新:挂载/获焦/定时轮询兜底;后端 telemetry→PubSub 戳为增强通道(无 WebSocket 客户端时轮询即可)。
 */
export function TodoBell() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const unreadQ = useQuery({
    queryKey: UNREAD_KEY,
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const recentQ = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => fetchTodos('recent', { limit: 8 }),
    enabled: open,
    refetchOnWindowFocus: true,
  })

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: UNREAD_KEY })
    void qc.invalidateQueries({ queryKey: RECENT_KEY })
    void qc.invalidateQueries({ queryKey: ['sysTodos'] })
  }, [qc])

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const unread = unreadQ.data ?? 0
  const recent = recentQ.data?.results ?? []

  async function openTodo(todo: SysTodo) {
    try {
      if (!todo.myReadAt) {
        await markTodoRead(todo.id)
        refresh()
      }
    } catch {
      // 跳转优先,已读失败不拦
    }
    setOpen(false)
    void navigate({ to: todoSourcePath(todo) })
  }

  async function onDismiss(e: React.MouseEvent, todo: SysTodo) {
    e.stopPropagation()
    try {
      await dismissTodo(todo.id)
      toast.success('已忽略')
      refresh()
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : '忽略失败')
    }
  }

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <Button
        isIconOnly
        variant="ghost"
        aria-label={unread > 0 ? `待办,${unread} 条未读` : '待办'}
        className="relative h-10 w-10 text-ink-900/70"
        onPress={() => setOpen((v) => !v)}
      >
        <IconBell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>
      <Dropdown.Popover placement="bottom end" className="w-80 p-0">
        <div className="border-b border-ink-900/10 px-3 py-2.5">
          <p className="text-sm font-medium">待办</p>
          <p className="mt-0.5 text-xs text-ink-500">
            {unread > 0 ? `${unread} 条未读` : '暂无未读'}
          </p>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {recentQ.isLoading && (
            <li className="px-3 py-4 text-center text-xs text-ink-500">加载中…</li>
          )}
          {!recentQ.isLoading && recent.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-ink-500">暂无待办</li>
          )}
          {recent.map((todo) => (
            <li key={todo.id}>
              <button
                type="button"
                onClick={() => void openTodo(todo)}
                className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-ink-900/5"
              >
                <div className="flex items-center gap-1.5">
                  <Chip size="sm" variant="soft">
                    {todoTypeLabel(todo.type)}
                  </Chip>
                  {!todo.myReadAt && (
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-ink" aria-label="未读" />
                  )}
                  {todo.draftInvoiceLinked && (
                    <Chip size="sm" variant="soft" color="warning">
                      草稿关联中
                    </Chip>
                  )}
                  <span className="ml-auto text-[11px] text-ink-500">
                    {formatTodoTime(todo.insertedAt)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{todo.sourceNo}</span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-500">
                    {formatAmount(todo.amount)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-ink-500">
                    {[todo.partyName, todo.company?.shortName || todo.company?.name]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <button
                    type="button"
                    className="text-[11px] text-ink-500 underline-offset-2 hover:underline"
                    onClick={(e) => void onDismiss(e, todo)}
                  >
                    忽略
                  </button>
                </div>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-ink-900/10 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onPress={() => {
              setOpen(false)
              void navigate({ to: '/todos' })
            }}
          >
            <Label>查看全部</Label>
          </Button>
        </div>
      </Dropdown.Popover>
    </Dropdown>
  )
}
