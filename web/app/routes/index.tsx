import { useEffect } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { addToast, Button, Card, CardBody, CardHeader, Spinner } from '@heroui/react'
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
      addToast({ title: '登录状态已失效,请重新登录', color: 'warning' })
      navigate({ to: '/login', replace: true })
    }
  }, [data, navigate])

  const logout = () => {
    clearToken()
    addToast({ title: '已退出登录', color: 'default' })
    navigate({ to: '/login' })
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-porcelain">
      <Card className="max-w-md w-full">
        <CardHeader className="flex justify-between items-center">
          <span className="text-xl font-semibold">Synie 企业资源管理系统</span>
          <Button size="sm" variant="light" onPress={logout}>
            退出登录
          </Button>
        </CardHeader>
        <CardBody>
          {isLoading ? (
            <Spinner label="加载中…" />
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
        </CardBody>
      </Card>
    </div>
  )
}
