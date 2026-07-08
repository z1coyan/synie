import { Link, createFileRoute } from '@tanstack/react-router'
import { Card, Chip } from '@heroui/react'
import { cardVariants } from '@heroui/styles'
import { menuModules } from '~/lib/menu'

export const Route = createFileRoute('/_app/')({
  component: DashboardPage,
})

// ponytail: 示例数据,业务模块接入后端后替换
const todos = [
  { title: '3 月采购订单 PO-20260301 待审批', source: '供应链', state: '待审批', color: 'warning' as const },
  { title: '新员工「李明」入职资料待完善', source: '人事', state: '进行中', color: 'accent' as const },
  { title: '2 月费用报销单 EX-0219 被驳回', source: '财务', state: '需处理', color: 'danger' as const },
  { title: '仓库 WH-01 库存盘点计划待确认', source: '供应链', state: '待确认', color: 'warning' as const },
]

const notices = [
  { title: '系统将于本周六 22:00–24:00 停机维护', date: '07-04' },
  { title: '第二季度预算调整流程已上线', date: '06-28' },
  { title: '新版考勤规则自 7 月 1 日起生效', date: '06-20' },
]

function DashboardPage() {
  const shortcuts = menuModules.filter((m) => m.key !== 'dashboard')

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">工作台</h1>
      <p className="mt-2 text-sm text-ink-500">一处纵览企业的人、财、物与流程。</p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-ink-500">快捷入口</h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {shortcuts.map((m) => (
            <Link
              key={m.key}
              to={m.entry}
              className={`${cardVariants().base()} flex-row items-center gap-4 no-underline transition-shadow hover:shadow-md`}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink-900 text-porcelain">
                <m.icon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="mt-0.5 block truncate text-xs text-ink-500/80">
                  {m.description}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <Card.Header className="flex-row items-center justify-between">
            <Card.Title className="text-sm font-medium">待办事项</Card.Title>
            <Chip size="sm" variant="soft">示例</Chip>
          </Card.Header>
          <Card.Content className="mt-2 gap-1">
            {todos.map((t) => (
              <div key={t.title} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{t.title}</p>
                  <p className="mt-0.5 text-xs text-ink-500/70">{t.source}</p>
                </div>
                <Chip size="sm" variant="soft" color={t.color}>
                  {t.state}
                </Chip>
              </div>
            ))}
          </Card.Content>
        </Card>

        <Card>
          <Card.Header className="flex-row items-center justify-between">
            <Card.Title className="text-sm font-medium">系统公告</Card.Title>
            <Chip size="sm" variant="soft">示例</Chip>
          </Card.Header>
          <Card.Content className="mt-2 gap-1">
            {notices.map((n) => (
              <div key={n.title} className="flex items-baseline gap-3 py-2">
                <p className="min-w-0 flex-1 truncate text-sm">{n.title}</p>
                <span className="text-xs tabular-nums text-ink-500/70">{n.date}</span>
              </div>
            ))}
          </Card.Content>
        </Card>
      </section>
    </>
  )
}
