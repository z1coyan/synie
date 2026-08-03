import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { ReceiptDrawerProvider } from './outsourced-receipts/-receipt-drawer'

export const Route = createFileRoute('/_app/purchase/outsourced-receipts')({
  component: OutsourcedReceiptsLayout,
})

const TABS = [
  { id: 'items', label: '入库条目' },
  { id: 'receipts', label: '入库单' },
] as const

function OutsourcedReceiptsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/purchase/outsourced-receipts/${t.id}`))?.id ?? 'items'

  return (
    <ReceiptDrawerProvider urlSync>
      <h1 className="font-brand text-3xl tracking-wide">委外入库</h1>
      <p className="mt-2 text-sm text-ink-500">
        登记协作方送回的成品：审核同事务成品入仓＋按比例扣外协仓材料＋副产物入仓，加工费过未开票应付。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key !== selected) navigate({ to: `/purchase/outsourced-receipts/${String(key)}` })
        }}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="委外入库视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={`/purchase/outsourced-receipts/${t.id}`}
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
