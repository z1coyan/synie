import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { OrderDrawerProvider } from './purchase/-order-drawer'

export const Route = createFileRoute('/_app/scm/purchase')({
  component: PurchaseOrdersLayout,
})

// 采购订单两视图一页承载(照销售订单 tabs 先例):订单条目(行级明细,默认视图)、
// 订单(整单 grid)。tab 即子路由,URL 可直达、可后退;三态订单抽屉两 tab 共用(见 -order-drawer.tsx)
const TABS = [
  { id: 'items', label: '订单条目' },
  { id: 'orders', label: '订单' },
] as const

function PurchaseOrdersLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected = TABS.find((t) => pathname.includes(`/scm/purchase/${t.id}`))?.id ?? 'items'

  return (
    <OrderDrawerProvider>
      <h1 className="font-brand text-3xl tracking-wide">采购订单</h1>
      <p className="mt-2 text-sm text-ink-500">
        公司向供应商承诺采购的订货单据:常规订单条目只能从有效采购报价挑选,零星订单自由录价受单行上限约束;审核后锁死(无反审核),仅可关闭或作废。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        // 鼠标点击由 Link 自己导航(保留中键新开等锚点语义),这里兜底键盘方向键切换
        onSelectionChange={(key) => navigate({ to: `/scm/purchase/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左,容器全宽底边保留 */}
          <Tabs.List aria-label="采购订单视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => <Link {...(domProps as object)} to={`/scm/purchase/${t.id}`} />}
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
    </OrderDrawerProvider>
  )
}
