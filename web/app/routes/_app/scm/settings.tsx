import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'

export const Route = createFileRoute('/_app/scm/settings')({
  component: ScmSettingsLayout,
})

// 供应链设置多视图一页承载(照基础设置 tabs 先例);tab 即子路由
const TABS = [
  { id: 'sales', label: '销售' },
  { id: 'purchase', label: '采购' },
] as const

function ScmSettingsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/scm/settings/${t.id}`))?.id ?? 'sales'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">供应链设置</h1>
      <p className="mt-2 text-sm text-ink-500">
        供应链全局配置（非公司维度）。销售与采购相关项分 Tab 维护，同一配置表落库。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => navigate({ to: `/scm/settings/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="供应链设置" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => (
                  <Link {...(domProps as object)} to={`/scm/settings/${t.id}`} />
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
