import { useEffect, useMemo } from 'react'
import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Tabs } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/scm/other-stock')({
  component: OtherStockLayout,
})

/**
 * 其他库存单:无业务上游的库存来源单据入口(纯 IA 壳)。
 * 三 tab 对应三资源(权限码/状态机/编号不动);tab 即子路由,URL 可直达可后退。
 * 无对应 read 的 tab 隐藏;默认/直链无权限时落到第一个可访问 tab。
 */
const ALL_TABS = [
  { id: 'docs', label: '出入库', read: 'inv.stock_doc:read', path: '/scm/other-stock/docs' },
  { id: 'transfers', label: '调拨', read: 'inv.stock_transfer:read', path: '/scm/other-stock/transfers' },
  { id: 'counts', label: '盘点', read: 'inv.stock_count:read', path: '/scm/other-stock/counts' },
] as const

type TabId = (typeof ALL_TABS)[number]['id']

function OtherStockLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const perms = useQuery({
    queryKey: ['myPermissions'],
    queryFn: () =>
      gqlFetch<{ myPermissions: string[] }>('query { myPermissions }').then((d) => new Set(d.myPermissions)),
    staleTime: 60_000,
  })

  // 权限未到前 fail-open 展示全部 tab,避免首屏空白闪;落地后按 read 隐藏
  const tabs = useMemo(() => {
    if (!perms.data) return [...ALL_TABS]
    return ALL_TABS.filter((t) => perms.data.has(t.read))
  }, [perms.data])

  const selected: TabId =
    ALL_TABS.find((t) => pathname.includes(`/scm/other-stock/${t.id}`))?.id ?? 'docs'

  // 当前 tab 无权限(或权限落地后当前 tab 被藏):静默落到第一个可访问 tab
  useEffect(() => {
    if (!perms.data || tabs.length === 0) return
    if (!tabs.some((t) => t.id === selected)) {
      navigate({ to: tabs[0].path, replace: true })
    }
  }, [perms.data, tabs, selected, navigate])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">其他库存单</h1>
      <p className="mt-2 text-sm text-ink-500">
        无业务上游的库存来源单据:出入库调整、仓间调拨、账实盘点。按类型分 tab 维护;公司在列表列与建单表单中选择。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        onSelectionChange={(key) => {
          const tab = tabs.find((t) => t.id === String(key))
          if (tab) navigate({ to: tab.path })
        }}
        className="mt-4"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="其他库存单" className="w-fit min-w-0 *:w-auto">
            {tabs.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => <Link {...(domProps as object)} to={t.path} />}
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
    </>
  )
}
