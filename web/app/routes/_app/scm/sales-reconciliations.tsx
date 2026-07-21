import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { ReconciliationDrawerProvider } from './sales-reconciliations/-reconciliation-drawer'

export const Route = createFileRoute('/_app/scm/sales-reconciliations')({
  component: SalesReconciliationsLayout,
})

const TABS = [
  { id: 'items', label: '对账条目' },
  { id: 'reconciliations', label: '对账单' },
] as const

function SalesReconciliationsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/scm/sales-reconciliations/${t.id}`))?.id ?? 'items'

  return (
    <ReconciliationDrawerProvider>
      <h1 className="font-brand text-3xl tracking-wide">销售对账</h1>
      <p className="mt-2 text-sm text-ink-500">
        发货与开票之间的勾稽:常规单客户确认后由开出发票关联结单;赠送/样品单审核即结单过账,兼任超发尾差核销。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => navigate({ to: `/scm/sales-reconciliations/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="销售对账视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => (
                  <Link {...(domProps as object)} to={`/scm/sales-reconciliations/${t.id}`} />
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
