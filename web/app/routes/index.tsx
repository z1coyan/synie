import { useEffect } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Card, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { clearToken, getToken } from '~/lib/auth'

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

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (typeof window !== 'undefined' && !getToken()) {
      throw redirect({ to: '/login' })
    }
  },
  component: HomeComponent,
})

function HomeComponent() {
  const navigate = useNavigate()

  const { data, isLoading, error } = useQuery({
    queryKey: ['me'],
    queryFn: () => gqlFetch<MeData>(ME_QUERY),
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
    <div className="min-h-screen flex items-center justify-center p-8 bg-porcelain">
      <Card className="max-w-md w-full">
        <Card.Header className="flex flex-row justify-between items-center">
          <span className="text-xl font-semibold">Synie 企业资源管理系统</span>
          <Button size="sm" variant="ghost" onPress={logout}>
            退出登录
          </Button>
        </Card.Header>
        <Card.Content>
          {isLoading ? (
            <div className="flex items-center gap-3">
              <Spinner size="sm" />
              <span className="text-sm">加载中…</span>
            </div>
          ) : error ? (
            <div className="text-danger">
              加载失败:{error instanceof Error ? error.message : String(error)}
            </div>
          ) : data?.me ? (
            <p className="text-sm leading-relaxed">
              当前用户:{data.me.name ?? data.me.username}({data.me.username})
            </p>
          ) : (
            <p className="text-sm">登录状态已失效,请退出后重新登录。</p>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}
