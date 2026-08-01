import type { ReactNode } from 'react'
import { AppearanceSwitch } from './appearance-switch'

export function ConvexAuthFrame(props: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen bg-porcelain text-ink-900">
      <aside className="relative hidden w-[52%] overflow-hidden bg-brand-ink text-brand-porcelain lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              'linear-gradient(rgba(250,250,247,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(250,250,247,.16) 1px,transparent 1px)',
            backgroundSize: '56px 56px',
          }}
        />
        <header className="relative z-10 flex items-baseline gap-3 px-12 pt-10">
          <span className="font-brand text-2xl tracking-wide">Synie</span>
          <span className="h-4 w-px bg-gilt/70" aria-hidden />
          <span className="text-xs tracking-[0.35em] text-brand-porcelain/60">
            企业资源管理系统
          </span>
        </header>
        <div className="relative z-10 max-w-xl px-12 pb-16">
          <h1 className="font-brand text-4xl leading-snug tracking-wide xl:text-5xl">
            可信身份,
            <br />
            权限有界。
          </h1>
          <p className="mt-6 text-sm leading-relaxed text-brand-porcelain/55">
            当前运行于 Convex 迁移验证模式，仅开放身份与最小工作台。
          </p>
        </div>
      </aside>

      <main className="relative flex flex-1 flex-col justify-center px-8 py-12 sm:px-16">
        <div className="absolute right-6 top-6 sm:right-10 sm:top-8">
          <AppearanceSwitch size="sm" />
        </div>
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-baseline gap-3 lg:hidden">
            <span className="font-brand text-2xl">Synie</span>
            <span className="text-xs tracking-[0.3em] text-ink-500">
              企业资源管理系统
            </span>
          </div>
          <h2 className="font-brand text-3xl tracking-wide">{props.title}</h2>
          <p className="mt-3 text-sm text-ink-500">{props.description}</p>
          {props.children}
          <p className="mt-16 text-xs text-ink-500/60">
            © 2026 Synie · 企业内部系统
          </p>
        </div>
      </main>
    </div>
  )
}
