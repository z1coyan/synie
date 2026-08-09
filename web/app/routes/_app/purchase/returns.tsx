import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { ReturnDrawerProvider } from './returns/-return-drawer'

export const Route = createFileRoute('/_app/purchase/returns')({
  component: PurchaseReturnsLayout,
})

const TABS = [
  { id: 'items', label: '退货条目' },
  { id: 'returns', label: '退货单' },
] as const

function PurchaseReturnsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/purchase/returns/${t.id}`))?.id ?? 'items'

  return (
    <ReturnDrawerProvider urlSync>
      <h1 className="font-brand text-3xl tracking-wide">采购退货</h1>
      <p className="mt-2 text-sm text-ink-500">
        退货出仓单据：审核后扣减库存、回减订单已收数量，有金额时按借贷科目冲减未开票应付。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key !== selected) navigate({ to: `/purchase/returns/${String(key)}` })
        }}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="采购退货视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={`/purchase/returns/${t.id}`}
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
    </ReturnDrawerProvider>
  )
}
