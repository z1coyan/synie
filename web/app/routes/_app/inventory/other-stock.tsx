import { useEffect } from 'react'
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { useResourceCapabilities } from '~/lib/use-resource-capabilities'

export const Route = createFileRoute('/_app/inventory/other-stock')({
  component: OtherStockLayout,
})

/**
 * 其他库存单:无业务上游的库存来源单据入口(纯 IA 壳)。
 * 三 tab 对应三资源(状态机/编号不动);tab 即子路由,URL 可直达可后退。
 * tab 可见性按资源文档可读性门控(文档 403 即不可见,fail-closed);
 * 默认/直链无权限时落到第一个可访问 tab。
 */
const ALL_TABS = [
  { id: 'docs', label: '出入库', resource: 'invStockDocs', path: '/inventory/other-stock/docs' },
  { id: 'transfers', label: '调拨', resource: 'invStockTransfers', path: '/inventory/other-stock/transfers' },
  { id: 'counts', label: '盘点', resource: 'invStockCounts', path: '/inventory/other-stock/counts' },
] as const

type TabId = (typeof ALL_TABS)[number]['id']

function OtherStockLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const docsCaps = useResourceCapabilities('invStockDocs')
  const transfersCaps = useResourceCapabilities('invStockTransfers')
  const countsCaps = useResourceCapabilities('invStockCounts')
  // 文档未解析期 fail-closed:先不渲染 tab(避免闪现后消失),解析后按可读性过滤
  const pending = docsCaps.pending || transfersCaps.pending || countsCaps.pending
  const readable: Record<(typeof ALL_TABS)[number]['resource'], boolean> = {
    invStockDocs: docsCaps.readable,
    invStockTransfers: transfersCaps.readable,
    invStockCounts: countsCaps.readable,
  }
  const tabs = pending ? [] : ALL_TABS.filter((t) => readable[t.resource])

  const selected: TabId =
    ALL_TABS.find((t) => pathname.includes(`/inventory/other-stock/${t.id}`))?.id ?? 'docs'

  // 当前 tab 无权限(或权限落地后当前 tab 被藏):静默落到第一个可访问 tab
  useEffect(() => {
    if (pending || tabs.length === 0) return
    if (!tabs.some((t) => t.id === selected)) {
      navigate({ to: tabs[0].path, replace: true })
    }
  }, [pending, tabs, selected, navigate])

  return (
    <>
      <h1 className="font-brand text-xl">其他库存单</h1>
      <p className="mt-1 text-xs text-ink-500">
        无业务上游的库存来源单据:出入库调整、仓间调拨、账实盘点。按类型分 tab 维护;公司在列表列与建单表单中选择。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key === selected) return
          const tab = tabs.find((t) => t.id === String(key))
          if (tab) navigate({ to: tab.path })
        }}
        className="mt-2"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="其他库存单" className="w-fit min-w-0 *:w-auto">
            {tabs.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                href={t.path}
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
    </>
  )
}
