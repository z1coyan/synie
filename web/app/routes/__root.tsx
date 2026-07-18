import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import { Toast } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { APPEARANCE_FOUC_SCRIPT } from '~/lib/appearance'
import '../../app.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // ERP 数据录入场景:切窗口不应触发全表重取;写操作后由页面显式 invalidate 刷新
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export const Route = createRootRoute({
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
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Toast.Provider placement="top" />
        <BootSplash />
        <Outlet />
      </QueryClientProvider>
    </RootDocument>
  )
}

/** 全局加载动效:玄蓝幕布上词标晕开,金线延展,随后幕布上下拉开露出页面 */
function BootSplash() {
  const [show, setShow] = useState(true)
  const reduced = useReducedMotion()

  useEffect(() => {
    const timer = setTimeout(() => setShow(false), reduced ? 0 : 1700)
    return () => clearTimeout(timer)
  }, [reduced])

  const curtainTransition = {
    duration: reduced ? 0 : 0.75,
    ease: [0.76, 0, 0.24, 1] as const,
  }

  return (
    <AnimatePresence>
      {show && (
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