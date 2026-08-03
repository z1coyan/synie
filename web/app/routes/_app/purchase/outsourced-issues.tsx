import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { IssueDrawerProvider } from './outsourced-issues/-issue-drawer'

export const Route = createFileRoute('/_app/purchase/outsourced-issues')({
  component: OutsourcedIssuesLayout,
})

const TABS = [
  { id: 'items', label: '发料条目' },
  { id: 'issues', label: '发料单' },
] as const

function OutsourcedIssuesLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected =
    TABS.find((t) => pathname.includes(`/purchase/outsourced-issues/${t.id}`))?.id ?? 'items'

  return (
    <IssueDrawerProvider urlSync>
      <h1 className="font-brand text-3xl tracking-wide">委外发料</h1>
      <p className="mt-2 text-sm text-ink-500">
        发给协作方的委外材料：审核后材料从调出仓移入外协仓并累加发料清单已发料量；无金额不过总账。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key !== selected) navigate({ to: `/purchase/outsourced-issues/${String(key)}` })
        }}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="委外发料视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={`/purchase/outsourced-issues/${t.id}`}
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
    </IssueDrawerProvider>
  )
}
