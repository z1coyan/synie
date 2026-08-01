import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  convexQuery,
  useConvexAuth,
  useConvexMutation,
} from '@convex-dev/react-query'
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

export function ConvexSetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const auth = useConvexAuth()
  const status = useQuery(convexQuery(api.setup.status.get, {}))
  const createFirstUser = useConvexMutation(
    api.setup.createFirstUser.createFirstUser,
  )
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (status.data?.initialized) {
      navigate({ to: auth.isAuthenticated ? '/' : '/login', replace: true })
    }
  }, [auth.isAuthenticated, navigate, status.data])

  const setup = useMutation({
    mutationFn: async () => {
      if (password !== confirmPassword) {
        throw new Error('password_mismatch')
      }
      const normalizedUsername = username.trim()
      await createFirstUser({
        username: normalizedUsername,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      })

      const signIn = await authClient.signIn.username({
        username: normalizedUsername,
        password,
      })
      return { signInError: signIn.error ?? null }
    },
    onSuccess: ({ signInError }) => {
      clearCatalogCache()
      queryClient.clear()
      if (signInError) {
        toast.warning('管理员已创建,请重新登录', {
          description: signInErrorMessage(signInError),
        })
        window.location.replace('/login')
        return
      }
      window.location.replace('/')
    },
    onError: (error) => {
      if (error instanceof Error && error.message === 'password_mismatch') {
        toast.danger('两次输入的密码不一致')
        return
      }
      const mapped = mapConvexError(error, '初始化失败,请稍后重试')
      toast.danger('初始化失败', { description: mapped.message })
    },
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password || !confirmPassword || setup.isPending) {
      return
    }
    setup.mutate()
  }

  if (status.isPending) {
    return (
      <ConvexAuthFrame title="初始化向导" description="正在确认部署状态">
        <div className="mt-10 flex h-40 items-center justify-center">
          <Spinner size="lg" />
        </div>
      </ConvexAuthFrame>
    )
  }

  if (status.isError) {
    const error = mapConvexError(status.error, '无法连接初始化服务,请稍后重试')
    return (
      <ConvexAuthFrame title="初始化向导" description="初始化服务暂时不可用">
        <div className="mt-10 flex flex-col items-start gap-4">
          <p className="text-sm text-ink-500">{error.message}</p>
          <Button variant="secondary" onPress={() => status.refetch()}>
            重试
          </Button>
        </div>
      </ConvexAuthFrame>
    )
  }

  if (status.data.hasUsers && !status.data.initialized) {
    return (
      <ConvexAuthFrame title="初始化向导" description="检测到不完整的初始化状态">
        <div className="mt-10 flex flex-col items-start gap-4">
          <p className="text-sm leading-6 text-ink-500">
            系统已存在账号，但初始化标记缺失。为避免覆盖已有账号，初始化入口已关闭，请联系运维人员检查恢复记录。
          </p>
          <Button variant="secondary" onPress={() => status.refetch()}>
            重新检查
          </Button>
        </div>
      </ConvexAuthFrame>
    )
  }

  return (
    <ConvexAuthFrame
      title="初始化向导"
      description="创建唯一的首位超级管理员"
    >
      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-5">
        <TextField
          value={username}
          onChange={setUsername}
          isDisabled={setup.isPending}
        >
          <Label>管理员用户名</Label>
          <Input autoFocus autoComplete="username" className="rounded-sm" />
        </TextField>
        <TextField
          value={name}
          onChange={setName}
          isDisabled={setup.isPending}
        >
          <Label>姓名（可选）</Label>
          <Input autoComplete="name" className="rounded-sm" />
        </TextField>
        <TextField
          value={password}
          onChange={setPassword}
          isDisabled={setup.isPending}
        >
          <Label>密码</Label>
          <InputGroup className="rounded-sm">
            <InputGroup.Input
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
            />
            <InputGroup.Suffix className="pr-1">
              <Button
                size="sm"
                variant="ghost"
                onPress={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? '隐藏' : '显示'}
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>
        <TextField
          value={confirmPassword}
          onChange={setConfirmPassword}
          isDisabled={setup.isPending}
        >
          <Label>确认密码</Label>
          <Input
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            className="rounded-sm"
          />
        </TextField>
        <Button
          type="submit"
          size="lg"
          isPending={setup.isPending}
          isDisabled={!username.trim() || !password || !confirmPassword}
          className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.2em] hover:bg-brand-ink-mid"
        >
          {setup.isPending ? '正在初始化' : '创建管理员并进入系统'}
        </Button>
      </form>
    </ConvexAuthFrame>
  )
}
