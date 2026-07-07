import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { addToast, Button, Input } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { getToken, setToken } from '~/lib/auth'

const LOGIN_MUTATION = `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user {
        id
        username
        name
      }
    }
  }
`

interface LoginData {
  login: {
    token: string
    user: { id: string; username: string; name: string | null }
  }
}

export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    if (typeof window !== 'undefined' && getToken()) {
      throw redirect({ to: '/' })
    }
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // beforeLoad 在 SSR 首屏时读不到 localStorage,客户端再兜底一次
  useEffect(() => {
    if (getToken()) {
      navigate({ to: '/', replace: true })
    }
  }, [navigate])

  const login = useMutation({
    mutationFn: () =>
      gqlFetch<LoginData>(LOGIN_MUTATION, { username, password }),
    onSuccess: (data) => {
      setToken(data.login.token)
      addToast({
        title: `欢迎回来,${data.login.user.name ?? data.login.user.username}`,
        color: 'success',
      })
      navigate({ to: '/' })
    },
    onError: (error) => {
      addToast({
        title: '登录失败',
        description: error instanceof Error ? error.message : '请稍后再试',
        color: 'danger',
      })
    },
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!username || !password || login.isPending) return
    login.mutate()
  }

  return (
    <div className="min-h-screen flex bg-porcelain text-ink-900">
      {/* 左栏:品牌面板 */}
      <aside className="relative hidden lg:flex lg:w-[52%] xl:w-[55%] flex-col justify-between overflow-hidden bg-ink-900 text-porcelain">
        <ResourceLattice />

        {/* 竖排铭文 */}
        <span
          aria-hidden
          className="absolute right-8 top-1/2 -translate-y-1/2 select-none text-xs tracking-[0.5em] text-porcelain/25 font-brand"
          style={{ writingMode: 'vertical-rl' }}
        >
          万物皆资源 · 秩序即效率
        </span>

        <header className="relative z-10 flex items-baseline gap-3 px-12 pt-10">
          <span className="font-brand text-2xl tracking-wide">Synie</span>
          <span className="h-4 w-px bg-gilt/70" aria-hidden />
          <span className="text-xs tracking-[0.35em] text-porcelain/60">
            企业资源管理系统
          </span>
        </header>

        <div className="relative z-10 px-12 pb-16 max-w-xl">
          <h1 className="font-brand text-4xl xl:text-5xl leading-snug tracking-wide">
            万物有序,
            <br />
            资源有踪。
          </h1>
          <p className="mt-6 text-sm leading-relaxed text-porcelain/55">
            一处登录,纵览企业的人、财、物与流程。
          </p>
          <div className="mt-10 flex items-center gap-4 text-[11px] tracking-[0.3em] text-porcelain/35">
            <span className="h-px w-10 bg-gilt/50" aria-hidden />
            <span>人事</span>
            <span>财务</span>
            <span>物料</span>
            <span>流程</span>
          </div>
        </div>
      </aside>

      {/* 右栏:登录表单 */}
      <main className="flex flex-1 flex-col justify-center px-8 sm:px-16">
        <div className="mx-auto w-full max-w-sm">
          {/* 小屏时的词标 */}
          <div className="mb-10 flex items-baseline gap-3 lg:hidden">
            <span className="font-brand text-2xl">Synie</span>
            <span className="text-xs tracking-[0.3em] text-ink-500">
              企业资源管理系统
            </span>
          </div>

          <h2 className="font-brand text-3xl tracking-wide">欢迎回来</h2>
          <p className="mt-3 text-sm text-ink-500">请使用企业账号登录</p>

          <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-5">
            <Input
              label="用户名"
              variant="bordered"
              radius="sm"
              autoFocus
              autoComplete="username"
              value={username}
              onValueChange={setUsername}
              isDisabled={login.isPending}
            />
            <Input
              label="密码"
              variant="bordered"
              radius="sm"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onValueChange={setPassword}
              isDisabled={login.isPending}
              endContent={
                <button
                  type="button"
                  className="self-center whitespace-nowrap text-xs text-ink-500 hover:text-ink-900 focus:outline-none"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              }
            />

            <Button
              type="submit"
              radius="sm"
              size="lg"
              isLoading={login.isPending}
              isDisabled={!username || !password}
              className="mt-2 bg-ink-900 text-porcelain tracking-[0.4em] data-[hover=true]:bg-ink-800"
            >
              {login.isPending ? '正在登录' : '登 录'}
            </Button>
          </form>

          <p className="mt-16 text-xs text-ink-500/60">
            © 2026 Synie · 企业内部系统,如需账号请联系管理员
          </p>
        </div>
      </main>
    </div>
  )
}

/** 左栏背景:细线经纬网格 + 呼吸的资源节点 */
function ResourceLattice() {
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="lattice" width="56" height="56" patternUnits="userSpaceOnUse">
          <path
            d="M 56 0 L 0 0 0 56"
            fill="none"
            stroke="rgba(250,250,247,0.05)"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="vignette" cx="30%" cy="70%" r="90%">
          <stop offset="0%" stopColor="#12305e" />
          <stop offset="100%" stopColor="#0a1e3f" />
        </radialGradient>
      </defs>

      <rect width="100%" height="100%" fill="url(#vignette)" />
      <rect width="100%" height="100%" fill="url(#lattice)" />

      {/* 资源节点:仓储网络的抽象连线 */}
      <g stroke="rgba(201,161,90,0.35)" strokeWidth="1" fill="none">
        <path d="M 168 168 L 392 224 L 336 448 L 112 392 Z" />
        <path d="M 392 224 L 616 168" />
        <path d="M 336 448 L 560 504" />
      </g>
      <g fill="#c9a15a">
        <circle className="node-breathe" cx="168" cy="168" r="3" />
        <circle className="node-breathe-late" cx="392" cy="224" r="4" />
        <circle className="node-breathe" cx="336" cy="448" r="3" />
        <circle className="node-breathe-late" cx="112" cy="392" r="2.5" />
        <circle className="node-breathe" cx="616" cy="168" r="2.5" />
        <circle className="node-breathe-late" cx="560" cy="504" r="3" />
      </g>
    </svg>
  )
}
