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
import { clearToken, getToken } from '~/lib/auth'
import { gqlFetch } from '~/lib/graphql'

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
  beforeLoad: () => {
    if (typeof window !== 'undefined' && !getToken()) {
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

  // beforeLoad 在 SSR 首屏时读不到 localStorage,客户端再兜底一次
  useEffect(() => {
    if (!getToken()) {
      navigate({ to: '/login', replace: true })
    }
  }, [navigate])

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
      <Outlet />
    </AppShell>
  )
}
