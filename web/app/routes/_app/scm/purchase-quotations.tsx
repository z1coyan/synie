import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'
import { QuotationDrawerProvider } from './purchase-quotations/-quotation-drawer'

export const Route = createFileRoute('/_app/scm/purchase-quotations')({
  component: PurchaseQuotationsLayout,
})

// 采购报价两视图一页承载(照销售报价 tabs 先例):报价条目(行级明细,默认视图)、
// 报价单(整单 grid)。tab 即子路由,URL 可直达、可后退;三态报价抽屉两 tab 共用
const TABS = [
  { id: 'items', label: '报价条目' },
  { id: 'quotations', label: '报价单' },
] as const

function PurchaseQuotationsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected = TABS.find((t) => pathname.includes(`/scm/purchase-quotations/${t.id}`))?.id ?? 'items'

  return (
    <QuotationDrawerProvider>
      <h1 className="font-brand text-3xl tracking-wide">采购报价</h1>
      <p className="mt-2 text-sm text-ink-500">
        供应商/内部公司向本公司的价格承诺清单:条目只报单价不含数量,支持固定价与数量梯度;审核后锁死(无反审核),截止日过后视为已过期,可作废撤回。
      </p>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        // 鼠标点击由 Link 自己导航(保留中键新开等锚点语义),这里兜底键盘方向键切换
        onSelectionChange={(key) => navigate({ to: `/scm/purchase-quotations/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左,容器全宽底边保留 */}
          <Tabs.List aria-label="采购报价视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => <Link {...(domProps as object)} to={`/scm/purchase-quotations/${t.id}`} />}
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
    </QuotationDrawerProvider>
  )
}
