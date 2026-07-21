import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { ReceiptDrawerProvider } from './purchase-receipts/-receipt-drawer'

export const Route = createFileRoute('/_app/scm/purchase-receipts')({
  component: PurchaseReceiptsLayout,
})

const TABS = [
  { id: 'items', label: '入库条目' },
  { id: 'receipts', label: '入库单' },
] as const

function PurchaseReceiptsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/scm/purchase-receipts/${t.id}`))?.id ?? 'items'

  return (
    <ReceiptDrawerProvider>
      <h1 className="font-brand text-3xl tracking-wide">采购入库</h1>
      <p className="mt-2 text-sm text-ink-500">
        履约入库单据：审核后增加库存、回写订单已收数量，有金额时按未开票应付科目过账。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => navigate({ to: `/scm/purchase-receipts/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="采购入库视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => (
                  <Link {...(domProps as object)} to={`/scm/purchase-receipts/${t.id}`} />
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
    </ReceiptDrawerProvider>
  )
}
