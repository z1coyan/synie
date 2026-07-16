import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'

export const Route = createFileRoute('/_app/hr/payroll')({
  component: PayrollLayout,
})

// 薪资三视图一页承载(照考勤 tabs 先例):工资单(核算+发放主动线)、
// 发放记录(全量发放流水)、借款台账(借款/归还+余额)。tab 即子路由,URL 可直达、可后退
const TABS = [
  { id: 'slips', label: '工资单' },
  { id: 'payments', label: '发放记录' },
  { id: 'loans', label: '借款台账' },
] as const

function PayrollLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected = TABS.find((t) => pathname.includes(`/hr/payroll/${t.id}`))?.id ?? 'slips'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">员工薪资</h1>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        // 鼠标点击由 Link 自己导航(保留中键新开等锚点语义),这里兜底键盘方向键切换
        onSelectionChange={(key) => navigate({ to: `/hr/payroll/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左,容器全宽底边保留 */}
          <Tabs.List aria-label="薪资视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => <Link {...(domProps as object)} to={`/hr/payroll/${t.id}`} />}
              >
                {t.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id={selected} className="pt-4">
          <Outlet />
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
