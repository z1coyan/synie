import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { OutputDrawerProvider } from './outputs/-output-drawer'

export const Route = createFileRoute('/_app/mfg/outputs')({
  component: OutputsLayout,
})

// 两视图一页承载(照销售发货/采购入库 tabs 先例):入库条目(行级明细,默认)、
// 入库单(整单 grid)。tab 即子路由,URL 可直达、可后退
const TABS = [
  { id: 'items', label: '入库条目' },
  { id: 'outputs', label: '入库单' },
] as const

function OutputsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/mfg/outputs/${t.id}`))?.id ?? 'items'

  return (
    <OutputDrawerProvider urlSync>
      <h1 className="font-brand text-3xl tracking-wide">生产入库</h1>
      <p className="mt-2 text-sm text-ink-500">
        对生产工单成品入账：行挂工单、可分次；审核写库存分录并累加工单已入，满量后工单完工。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key !== selected) navigate({ to: `/mfg/outputs/${String(key)}` })
        }}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="生产入库视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={`/mfg/outputs/${t.id}`}
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
    </OutputDrawerProvider>
  )
}
