import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { DeliveryDrawerProvider } from './deliveries/-delivery-drawer'

export const Route = createFileRoute('/_app/sales/deliveries')({
  component: SalesDeliveriesLayout,
})

const TABS = [
  { id: 'items', label: '发货条目' },
  { id: 'deliveries', label: '发货单' },
] as const

function SalesDeliveriesLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/sales/deliveries/${t.id}`))?.id ?? 'items'

  return (
    <DeliveryDrawerProvider urlSync>
      <h1 className="font-brand text-xl">销售发货</h1>
      <p className="mt-1 text-xs text-ink-500">
        履约出库单据：审核后扣减库存、回写订单已发数量，有金额时按未开票应收科目过账。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key !== selected) navigate({ to: `/sales/deliveries/${String(key)}` })
        }}
        className="mt-2"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="销售发货视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={`/sales/deliveries/${t.id}`}
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
    </DeliveryDrawerProvider>
  )
}
