import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { DemandDrawerProvider } from './demands/-demand-drawer'

export const Route = createFileRoute('/_app/mfg/demands')({
  component: DemandsLayout,
})

// 两视图一页承载(照销售订单 tabs 先例):需求行(行级明细,默认视图,日常跟单)、
// 需求单(整单 grid + 三态抽屉)。tab 即子路由,URL 可直达、可后退
const TABS = [
  { id: 'items', label: '需求行' },
  { id: 'orders', label: '需求单' },
] as const

function DemandsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/mfg/demands/${t.id}`))?.id ?? 'items'

  return (
    <DemandDrawerProvider>
      <h1 className="font-brand text-3xl tracking-wide">需求单</h1>
      <p className="mt-2 text-sm text-ink-500">
        履约需求单：计划从销售勾选或手工建独立需求；确认后按安排子表混排生产/采购/委外/库存/关闭，行完成由已安排与已完成双投影自动判定。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        // 鼠标点击由 Link 自己导航(保留中键新开等锚点语义),这里兜底键盘方向键切换
        onSelectionChange={(key) =>
          navigate({ to: `/mfg/demands/${String(key)}` })
        }
        className="mt-4"
      >
        <Tabs.ListContainer>
          {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左,容器全宽底边保留 */}
          <Tabs.List aria-label="需求单视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => (
                  <Link {...(domProps as object)} to={`/mfg/demands/${t.id}`} />
                )}
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
    </DemandDrawerProvider>
  )
}
