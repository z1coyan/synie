import { useEffect } from 'react'
import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { AppShell } from '~/components/app-shell'
import { FkPreviewProvider } from '~/components/synie-record-drawer/fk-preview-provider'
import { clearToken, getToken } from '~/lib/auth'
import { APIError } from '~/lib/api/client'
import { fetchMe } from '~/lib/api/session'
import { clearCatalogCache, setCatalogActor } from '~/lib/resources/catalog'
import { fetchSetupStatus } from '~/lib/setup'

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    // SSR 首屏发不了相对路径 fetch 也读不到 localStorage,客户端在组件内再兜底(同 login.tsx 模式)
    if (typeof window === 'undefined') return
    // 未完成初始化:除 /setup 与 /login 外一律先进向导(向导第 1 步自带登录续作)
    const status = await fetchSetupStatus().catch(() => null)
    if (status && !status.initialized) {
      throw redirect({ to: '/setup' })
    }
    if (!getToken()) {
      throw redirect({ to: '/login' })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()

  const { data, error: meError, isError: meIsError } = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    // 没 token 时不发请求,避免把 me:null 缓存下来误判成登录态失效
    enabled: !!getToken(),
  })

  // 初始化门控(未认证可查);查询失败 fail-open 维持现状,避免与 /setup 互弹死循环
  const { data: setupStatus, isError: setupStatusError } = useQuery({
    queryKey: ['setupStatus'],
    queryFn: fetchSetupStatus,
  })

  // beforeLoad 在 SSR 首屏被跳过,客户端兜底:两个跳转必须等 setupStatus 落定再判去向——
  // 未初始化进向导;已初始化(或查询失败 fail-open)且无 token 回登录页。
  // 若让「无 token → /login」同步抢跑,setupStatus 异步回来时组件已卸载,永远进不了向导
  useEffect(() => {
    if (setupStatus && !setupStatus.initialized) {
      navigate({ to: '/setup', replace: true })
      return
    }
    if ((setupStatus || setupStatusError) && !getToken()) {
      navigate({ to: '/login', replace: true })
    }
  }, [setupStatus, setupStatusError, navigate])

  // Actor 隔离 Catalog 缓存：me 到达后绑定 userId；切换账号不会复用能力投影
  useEffect(() => {
    if (data?.user?.id) setCatalogActor(data.user.id)
  }, [data?.user?.id])

  // Go API 明确返回 401 时清除 JWT 并回登录页;其它网络错误留在页面重试。
  useEffect(() => {
    if (meIsError && meError instanceof APIError && meError.code === 'unauthorized') {
      clearToken()
      clearCatalogCache()
      toast.warning('登录状态已失效,请重新登录')
      navigate({ to: '/login', replace: true })
    }
  }, [meError, meIsError, navigate])

  const logout = () => {
    clearToken()
    clearCatalogCache()
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
