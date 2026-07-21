import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { ReconciliationDrawerProvider } from './purchase-reconciliations/-reconciliation-drawer'

export const Route = createFileRoute('/_app/scm/purchase-reconciliations')({
  component: PurchaseReconciliationsLayout,
})

const TABS = [
  { id: 'items', label: '对账条目' },
  { id: 'reconciliations', label: '对账单' },
] as const

function PurchaseReconciliationsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/scm/purchase-reconciliations/${t.id}`))?.id ?? 'items'

  return (
    <ReconciliationDrawerProvider>
      <h1 className="font-brand text-3xl tracking-wide">采购对账</h1>
      <p className="mt-2 text-sm text-ink-500">
        入库与收票之间的勾稽:常规单供应商确认后由开入发票关联结单;赠送/样品单结单审核即过账,兼任超收尾差核销。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) =>
          navigate({ to: `/scm/purchase-reconciliations/${String(key)}` })
        }
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="采购对账视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => (
                  <Link {...(domProps as object)} to={`/scm/purchase-reconciliations/${t.id}`} />
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
    </ReconciliationDrawerProvider>
  )
}
