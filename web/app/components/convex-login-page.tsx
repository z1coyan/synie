import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { convexQuery, useConvexAuth } from '@convex-dev/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Button,
  Input,
  InputGroup,
  Label,
  Spinner,
  TextField,
  toast,
} from '@heroui/react'
import { authClient, signInErrorMessage } from '~/lib/auth-client'
import { api } from '~/lib/convex-api'
import { mapConvexError } from '~/lib/convex-errors'
import { clearCatalogCache } from '~/lib/resources/catalog'
import { ConvexAuthFrame } from './convex-auth-frame'

export function ConvexLoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const auth = useConvexAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const setupStatus = useQuery(convexQuery(api.setup.status.get, {}))
  // Convex auth state 决定是否查询 Actor；不能用 Better Auth session 抢跑。
  const me = useQuery({
    ...convexQuery(api.iam.me.get, {}),
    enabled: auth.isAuthenticated,
  })

  useEffect(() => {
    if (setupStatus.data && !setupStatus.data.initialized) {
      navigate({ to: '/setup', replace: true })
    }
  }, [navigate, setupStatus.data])

  useEffect(() => {
    if (me.data) navigate({ to: '/', replace: true })
  }, [me.data, navigate])

  const login = useMutation({
    mutationFn: async () => {
      const result = await authClient.signIn.username({
        username: username.trim(),
        password,
      })
      if (result.error) throw result.error
    },
    onSuccess: () => {
      clearCatalogCache()
      queryClient.clear()
      // 官方 Provider 以 cookie 重新建立 Convex auth；reload 避免 readiness race。
      window.location.replace('/')
    },
    onError: (error) => {
      toast.danger('登录失败', { description: signInErrorMessage(error) })
    },
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password || login.isPending) return
    login.mutate()
  }

  if (setupStatus.isPending) {
    return (
      <ConvexAuthFrame title="欢迎回来" description="正在确认系统初始化状态">
        <div className="mt-10 flex h-40 items-center justify-center">
          <Spinner size="lg" />
        </div>
      </ConvexAuthFrame>
    )
  }

  if (setupStatus.isError) {
    const error = mapConvexError(setupStatus.error, '无法连接身份服务,请稍后重试')
    return (
      <ConvexAuthFrame title="欢迎回来" description="身份服务暂时不可用">
        <div className="mt-10 flex flex-col items-start gap-4">
          <p className="text-sm text-ink-500">{error.message}</p>
          <Button variant="secondary" onPress={() => setupStatus.refetch()}>
            重试
          </Button>
        </div>
      </ConvexAuthFrame>
    )
  }

  return (
    <ConvexAuthFrame title="欢迎回来" description="请使用企业账号登录">
      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-5">
        <TextField
          value={username}
          onChange={setUsername}
          isDisabled={login.isPending || auth.isLoading}
        >
          <Label>用户名</Label>
          <Input autoFocus autoComplete="username" className="rounded-sm" />
        </TextField>
        <TextField
          value={password}
          onChange={setPassword}
          isDisabled={login.isPending || auth.isLoading}
        >
          <Label>密码</Label>
          <InputGroup className="rounded-sm">
            <InputGroup.Input
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
            />
            <InputGroup.Suffix className="pr-1">
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-ink-500 hover:text-ink-900"
                onPress={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? '隐藏' : '显示'}
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>
        <Button
          type="submit"
          size="lg"
          isPending={login.isPending}
          isDisabled={!username.trim() || !password || auth.isLoading}
          className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.4em] hover:bg-brand-ink-mid"
        >
          {login.isPending ? '正在登录' : '登 录'}
        </Button>
      </form>
    </ConvexAuthFrame>
  )
}
