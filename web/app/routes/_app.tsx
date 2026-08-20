import { useEffect } from 'react'
import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { AppShell } from '~/components/app-shell'
import { FkPreviewProvider } from '~/components/synie-record-drawer/fk-preview-provider'
import { authClient } from '~/lib/auth-client'
import { APIError } from '~/lib/api/client'
import { fetchMe, meEnsureQuery } from '~/lib/api/session'
import { clearCatalogCache, setCatalogActor } from '~/lib/resources/catalog'
import { setupStatusEnsureQuery } from '~/lib/setup'

export const Route = createFileRoute('/_app')({
  // SSR 与客户端导航同一条路径:cookie 由同构 api client 转发,SSR 下 redirect 即 302
  beforeLoad: async ({ context: { queryClient } }) => {
    // 未完成初始化:除 /setup 与 /login 外一律先进向导(向导第 1 步自带登录续作);
    // 状态查询失败 fail-open,避免与 /setup 互弹死循环
    const status = await queryClient
      .ensureQueryData(setupStatusEnsureQuery)
      .catch(() => null)
    if (status && !status.initialized) {
      throw redirect({ to: '/setup' })
    }
    // 登录态在此裁决:401 直接去登录页,不再先挂布局再靠组件效应弹回
    try {
      await queryClient.ensureQueryData(meEnsureQuery)
    } catch (error) {
      if (error instanceof APIError && error.code === 'unauthorized') {
        throw redirect({ to: '/login' })
      }
      // 其它错误(网络等)fail-open:进布局由组件级 me 查询呈现与重试
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 首访已由 beforeLoad 确保;这里同 key 共缓存,负责会话中途过期的持续观察
  const { data, error: meError, isError: meIsError } = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
  })

  // Actor 隔离 Catalog 缓存：me 到达后绑定 userId；切换账号不会复用能力投影
  useEffect(() => {
    if (data?.user?.id) setCatalogActor(data.user.id)
  }, [data?.user?.id])

  // 业务面密度 token:抽屉/筛选弹层 portal 到 body,靠此类收紧控件;登录/向导无此 class
  useEffect(() => {
    document.body.classList.add('synie-dense')
    return () => document.body.classList.remove('synie-dense')
  }, [])

  // 会话中途过期的客户端兜底:me 明确 401 回登录页;其它网络错误留在页面重试。
  useEffect(() => {
    if (meIsError && meError instanceof APIError && meError.code === 'unauthorized') {
      clearCatalogCache()
      toast.warning('登录状态已失效,请重新登录')
      navigate({ to: '/login', replace: true })
    }
  }, [meError, meIsError, navigate])

  const logout = async () => {
    // 会话可能已过期,注销失败不阻断本地清场
    await authClient.signOut().catch(() => undefined)
    clearCatalogCache()
    // 清掉 me 缓存,否则登录页 30s staleTime 内会拿旧数据误判已登录弹回工作台
    queryClient.removeQueries({ queryKey: ['me'] })
    toast('已退出登录')
    navigate({ to: '/login' })
  }

  return (
    <AppShell
      user={data ? { ...data.user, name: data.user.name ?? null } : null}
      menuCodes={data?.menuCodes}
      onLogout={logout}
    >
      <FkPreviewProvider>
        <Outlet />
      </FkPreviewProvider>
    </AppShell>
  )
}
