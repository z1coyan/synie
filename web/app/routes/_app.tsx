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
import { gqlFetch } from '~/lib/graphql'
import { fetchSetupStatus } from '~/lib/setup'

const ME_QUERY = `
  query Me {
    me {
      id
      username
      name
    }
  }
`

interface MeData {
  me: { id: string; username: string; name: string | null } | null
}

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

  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () => gqlFetch<MeData>(ME_QUERY),
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

  // token 失效(me 为空)时清除并回登录页
  useEffect(() => {
    if (data && !data.me) {
      clearToken()
      toast.warning('登录状态已失效,请重新登录')
      navigate({ to: '/login', replace: true })
    }
  }, [data, navigate])

  const logout = () => {
    clearToken()
    toast('已退出登录')
    navigate({ to: '/login' })
  }

  return (
    <AppShell user={data?.me ?? null} onLogout={logout}>
      <FkPreviewProvider>
        <Outlet />
      </FkPreviewProvider>
    </AppShell>
  )
}
