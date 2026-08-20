import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Chip, Tabs, toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import {
  dismissTodo,
  fetchTodos,
  formatTodoTime,
  markTodoRead,
  todoSourcePath,
  todoTypeLabel,
  type SysTodo,
  type TodoTab,
} from '~/lib/todo'

export const Route = createFileRoute('/_app/todos')({
  component: TodosPage,
})

function TodosPage() {
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const navigate = useNavigate()
  const qc = useQueryClient()

  const listQ = useQuery({
    queryKey: ['sysTodos', tab],
    queryFn: () => fetchTodos(tab as TodoTab, { limit: 50 }),
    refetchOnWindowFocus: true,
  })

  const rows = listQ.data?.results ?? []

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['sysTodos'] })
    void qc.invalidateQueries({ queryKey: ['sysTodoUnreadCount'] })
  }

  async function openTodo(todo: SysTodo) {
    try {
      if (todo.status === 'ACTIVE' && !todo.myReadAt) {
        await markTodoRead(todo.id)
        refresh()
      }
    } catch {
      // 跳转优先
    }
    void navigate({ to: todoSourcePath(todo) })
  }

  async function onDismiss(todo: SysTodo) {
    try {
      await dismissTodo(todo.id)
      toast.success('已忽略')
      refresh()
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : '忽略失败')
    }
  }

  return (
    <>
      <h1 className="font-brand text-xl">待办</h1>
      <p className="mt-1 text-xs text-ink-500">
        对账确认后的开票/收票提醒:随源单据状态自动出现、关闭与复活;个人可已读或忽略。
      </p>

      <Tabs
        variant="secondary"
        selectedKey={tab}
        onSelectionChange={(key) => setTab(String(key) as 'active' | 'history')}
        className="mt-2"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="待办视图" className="w-fit min-w-0 *:w-auto">
            <Tabs.Tab id="active">
              活跃
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="history">
              历史
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id={tab} className="pt-2">
          {listQ.isLoading && (
            <p className="py-8 text-center text-sm text-ink-500">加载中…</p>
          )}
          {!listQ.isLoading && rows.length === 0 && (
            <p className="py-12 text-center text-sm text-ink-500">
              {tab === 'active' ? '暂无活跃待办' : '暂无历史记录'}
            </p>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-ink-900/10">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-ink-900/10 bg-ink-900/[0.03] text-xs text-ink-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">类型</th>
                    <th className="px-4 py-2.5 font-medium">对账单号</th>
                    <th className="px-4 py-2.5 font-medium">对手</th>
                    <th className="px-4 py-2.5 font-medium">公司</th>
                    <th className="px-4 py-2.5 font-medium text-right">金额</th>
                    <th className="px-4 py-2.5 font-medium">产生时间</th>
                    {tab === 'history' && (
                      <th className="px-4 py-2.5 font-medium">关闭</th>
                    )}
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((todo) => (
                    <tr
                      key={todo.id}
                      className="border-b border-ink-900/5 last:border-0 hover:bg-ink-900/[0.02]"
                    >
                      <td className="px-4 py-3">
                        <Chip size="sm" variant="soft">
                          {todoTypeLabel(todo.type)}
                        </Chip>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="font-medium text-brand-ink underline-offset-2 hover:underline"
                          onClick={() => void openTodo(todo)}
                        >
                          {todo.sourceNo}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-ink-500">
                        {todo.partyName || '—'}
                      </td>
                      <td className="px-4 py-3 text-ink-500">
                        {todo.company?.shortName || todo.company?.name || '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatAmount(todo.amount)}
                      </td>
                      <td className="px-4 py-3 text-ink-500">
                        {formatTodoTime(todo.insertedAt)}
                      </td>
                      {tab === 'history' && (
                        <td className="px-4 py-3 text-ink-500">
                          {todo.closedReason === 'INVOICE_AUDIT'
                            ? '发票审核'
                            : todo.closedReason === 'UNCONFIRM'
                              ? '撤回确认'
                              : '—'}
                          {todo.closedAt ? (
                            <span className="ml-1 text-[11px]">
                              {formatTodoTime(todo.closedAt)}
                            </span>
                          ) : null}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          {todo.status === 'ACTIVE' && !todo.myReadAt && (
                            <Chip size="sm" variant="soft" color="accent">
                              未读
                            </Chip>
                          )}
                          {todo.draftInvoiceLinked && (
                            <Chip size="sm" variant="soft" color="warning">
                              草稿关联中
                            </Chip>
                          )}
                          {todo.status === 'CLOSED' && (
                            <Chip size="sm" variant="soft">
                              已关闭
                            </Chip>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {todo.status === 'ACTIVE' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onPress={() => void onDismiss(todo)}
                          >
                            忽略
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
