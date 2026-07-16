import { Link, Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Tabs } from '@heroui/react'

export const Route = createFileRoute('/_app/hr/attendance')({
  component: AttendanceLayout,
})

// 考勤两视图一页承载(照承兑 tabs 先例):打卡记录(原始事实台账,只读)、导入记录
// (.dat 批次列表与上传/执行/撤销动线)。tab 即子路由,URL 可直达、可后退
const TABS = [
  { id: 'punches', label: '打卡记录' },
  { id: 'imports', label: '导入记录' },
] as const

function AttendanceLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const selected = TABS.find((t) => pathname.includes(`/hr/attendance/${t.id}`))?.id ?? 'punches'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">考勤</h1>
      <Tabs
        variant="secondary"
        selectedKey={selected}
        // 鼠标点击由 Link 自己导航(保留中键新开等锚点语义),这里兜底键盘方向键切换
        onSelectionChange={(key) => navigate({ to: `/hr/attendance/${String(key)}` })}
        className="mt-4"
      >
        <Tabs.ListContainer>
          {/* 默认 min-w-full + tab w-full 满宽平分;收紧为内容宽靠左,容器全宽底边保留 */}
          <Tabs.List aria-label="考勤视图" className="w-fit min-w-0 *:w-auto">
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.id}
                id={t.id}
                render={(domProps) => <Link {...(domProps as object)} to={`/hr/attendance/${t.id}`} />}
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
