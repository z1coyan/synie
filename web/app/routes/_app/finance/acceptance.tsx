import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'

export const Route = createFileRoute('/_app/finance/acceptance')({
  component: AcceptanceLayout,
})

// 承兑汇票两视图一页承载:交易(接收录入/审核动线)、持有(当前库存快照+后续交易/票面修正入口)。
// 原「票据台账」并入:票面档案随 billId fk 速览全局可达(registry accBills),票面修正走持有段行操作。
// tab 即子路由,URL 可直达、可后退;选中态由 pathname 反推,不另存状态
const TABS = [
  { id: 'transactions', label: '承兑交易' },
  { id: 'holdings', label: '持有承兑' },
] as const

function AcceptanceLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected = TABS.find((t) => pathname.includes(`/finance/acceptance/${t.id}`))?.id ?? 'transactions'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">承兑汇票</h1>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        // 鼠标点击由 Link 自己导航(保留中键新开等锚点语义),这里兜底键盘方向键切换
        onSelectionChange={(key) => navigate({ to: `/finance/acceptance/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左,容器全宽底边保留 */}
          <Tabs.List aria-label="承兑汇票视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => <Link {...(domProps as object)} to={`/finance/acceptance/${t.id}`} />}
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
