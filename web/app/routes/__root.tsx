import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Outlet,
  createRootRouteWithContext,
  useNavigate,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import { RouterProvider } from 'react-aria-components'
import { Toast } from '@heroui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { APPEARANCE_FOUC_SCRIPT } from '~/lib/appearance'
import type { AppRouterContext } from '~/lib/query-client'
import '../../app.css'

export const Route = createRootRouteWithContext<AppRouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Synie 企业资源管理系统' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  // 与 getRouter() 注入的 context.queryClient 为同一实例（浏览器单例）
  const { queryClient } = Route.useRouteContext()
  // RAC RouterProvider:带 href 的组件(Tabs.Tab 等)点击时走 TanStack 客户端导航,
  // 修键/中键仍由 RAC 放行浏览器默认锚点行为
  const navigate = useNavigate()
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <RouterProvider navigate={(path) => void navigate({ href: path })}>
          <Toast.Provider placement="top" />
          <BootSplash />
          <Outlet />
        </RouterProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

const BOOT_SPLASH_SEEN_KEY = 'synie:boot-splash-seen'

/**
 * 全局加载动效:玄蓝幕布上词标晕开,金线延展,随后幕布上下拉开露出页面。
 * 只在本会话首次完整加载播放。hydration 安全:服务端与客户端初始渲染一致
 * (都渲染幕布),mount 后查 sessionStorage——看过则立即隐藏(无动画),
 * 没看过才播 1.7s 并落标记。
 */
function BootSplash() {
  // boot: SSR/客户端首帧一致渲染幕布;playing: 本会话首播;done: 隐藏
  const [phase, setPhase] = useState<'boot' | 'playing' | 'done'>('boot')
  // 是否真的播过:决定隐藏时走幕布拉开动画还是直接消失
  const played = useRef(false)
  const reduced = useReducedMotion()

  useEffect(() => {
    let seen = false
    try {
      seen = sessionStorage.getItem(BOOT_SPLASH_SEEN_KEY) === '1'
      if (!seen) sessionStorage.setItem(BOOT_SPLASH_SEEN_KEY, '1')
    } catch {
      // 隐私模式等 sessionStorage 不可用:按未看过处理,照常播
    }
    if (seen) {
      setPhase('done')
      return
    }
    played.current = true
    setPhase('playing')
    const timer = setTimeout(() => setPhase('done'), reduced ? 0 : 1700)
    return () => clearTimeout(timer)
  }, [reduced])

  const curtainTransition = {
    duration: reduced ? 0 : 0.75,
    ease: [0.76, 0, 0.24, 1] as const,
  }

  // 本会话已看过:不进 AnimatePresence,立即消失不播出场动画
  if (phase === 'done' && !played.current) return null

  return (
    <AnimatePresence>
      {phase !== 'done' && (
        <motion.div
          aria-hidden
          className="fixed inset-0 z-50 overflow-hidden"
          exit={{ pointerEvents: 'none' }}
        >
          <motion.div
            className="absolute inset-x-0 top-0 h-1/2 bg-brand-ink"
            exit={{ y: '-100%' }}
            transition={curtainTransition}
          />
          <motion.div
            className="absolute inset-x-0 bottom-0 h-1/2 bg-brand-ink"
            exit={{ y: '100%' }}
            transition={curtainTransition}
          />
          <motion.div
            className="absolute inset-0 flex flex-col items-center justify-center gap-5 text-brand-porcelain"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.25 } }}
          >
            <motion.span
              className="font-brand text-5xl sm:text-6xl"
              initial={{ opacity: 0, y: 14, letterSpacing: '0.6em' }}
              animate={{ opacity: 1, y: 0, letterSpacing: '0.18em' }}
              transition={{ duration: reduced ? 0 : 1.1, ease: 'easeOut' }}
            >
              Synie
            </motion.span>
            <motion.span
              className="h-px w-44 bg-gilt"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{
                delay: reduced ? 0 : 0.45,
                duration: reduced ? 0 : 0.7,
                ease: 'easeOut',
              }}
            />
            <motion.span
              className="text-xs tracking-[0.5em] text-brand-porcelain/60"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduced ? 0 : 0.7, duration: reduced ? 0 : 0.6 }}
            >
              企业资源管理系统
            </motion.span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 阻塞式防闪:在 hydrate 前按本机外观模式挂 class/data-theme */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_FOUC_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
