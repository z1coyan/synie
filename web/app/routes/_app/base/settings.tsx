import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'

export const Route = createFileRoute('/_app/base/settings')({
  component: BaseSettingsLayout,
})

// 基础设置多视图一页承载(照考勤/薪资 tabs 先例);tab 即子路由
const TABS = [{ id: 'market-fetch', label: '行情拉取' }] as const

function BaseSettingsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/base/settings/${t.id}`))?.id ?? 'market-fetch'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">基础设置</h1>
      <p className="mt-2 text-sm text-ink-500">
        基础数据相关全局配置（非公司维度）。行情节奏与主数据维护配合使用。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => navigate({ to: `/base/settings/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="基础设置" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => (
                  <Link {...(domProps as object)} to={`/base/settings/${t.id}`} />
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
    </>
  )
}
