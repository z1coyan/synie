import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { ReturnDrawerProvider } from './outsourced-returns/-return-drawer'

export const Route = createFileRoute('/_app/purchase/outsourced-returns')({
  component: PurchaseOutsourcedReturnsLayout,
})

const TABS = [
  { id: 'items', label: '退货条目' },
  { id: 'returns', label: '退货单' },
] as const

function PurchaseOutsourcedReturnsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/purchase/outsourced-returns/${t.id}`))?.id ?? 'items'

  return (
    <ReturnDrawerProvider urlSync>
      <h1 className="font-brand text-xl">委外退货</h1>
      <p className="mt-1 text-xs text-ink-500">
        委外退货单据：加工不良成品退回协作方返修；纯数量单——审核只写成品出仓分录并回减已收数量，不过总账、不进对账。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key !== selected) navigate({ to: `/purchase/outsourced-returns/${String(key)}` })
        }}
        className="mt-2"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="委外退货视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={`/purchase/outsourced-returns/${t.id}`}
              >
                {t.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id={selected} className="pt-2">
          <Outlet />
        </Tabs.Panel>
      </Tabs>
    </ReturnDrawerProvider>
  )
}
