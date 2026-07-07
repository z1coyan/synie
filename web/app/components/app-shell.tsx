import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Avatar,
  Breadcrumbs,
  Button,
  Description,
  Dropdown,
  Label,
  ScrollShadow,
  Tooltip,
} from '@heroui/react'
import {
  isPathActive,
  itemForPath,
  menuModules,
  moduleForPath,
} from '~/lib/menu'

interface AppShellProps {
  user: { username: string; name: string | null } | null
  onLogout: () => void
  children: ReactNode
}

/** 双列菜单布局:左侧模块图标栏 + 二级菜单面板 + 顶栏 + 内容区 */
export function AppShell({ user, onLogout, children }: AppShellProps) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const navigate = useNavigate()
  const activeModule = moduleForPath(pathname) ?? menuModules[0]
  const activeItem = itemForPath(pathname)
  const displayName = user ? (user.name ?? user.username) : '…'

  const crumbs =
    activeModule.key === 'dashboard'
      ? [activeModule.label]
      : [activeModule.label, activeItem?.label].filter(
          (c): c is string => Boolean(c)
        )

  return (
    <div className="flex h-screen bg-porcelain text-ink-900">
      {/* 第一列:模块图标栏 */}
      <nav
        aria-label="模块导航"
        className="flex w-16 shrink-0 flex-col items-center bg-ink-900 py-5 text-porcelain"
      >
        <Link
          to="/"
          aria-label="回到工作台"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-gilt/60"
        >
          <span className="font-brand text-xl leading-none text-gilt">S</span>
        </Link>

        <div className="mt-8 flex flex-col items-center gap-2">
          {menuModules.map((m) => {
            const active = m.key === activeModule.key
            return (
              <Tooltip key={m.key} delay={0}>
                <Button
                  isIconOnly
                  variant="ghost"
                  aria-label={m.label}
                  aria-current={active ? 'true' : undefined}
                  onPress={() => navigate({ to: m.entry })}
                  className={`relative h-11 w-11 rounded-xl ${
                    active
                      ? 'bg-porcelain/15 text-porcelain hover:bg-porcelain/15'
                      : 'text-porcelain/45 hover:bg-porcelain/10 hover:text-porcelain/90'
                  }`}
                >
                  <m.icon className="h-[22px] w-[22px]" />
                  {active && (
                    <span
                      aria-hidden
                      className="absolute -left-2.5 h-5 w-0.5 rounded-full bg-gilt"
                    />
                  )}
                </Button>
                <Tooltip.Content placement="right">{m.label}</Tooltip.Content>
              </Tooltip>
            )
          })}
        </div>

        <div className="mt-auto">
          <Dropdown>
            <Button
              isIconOnly
              variant="ghost"
              aria-label="用户菜单"
              className="h-10 w-10 rounded-full"
            >
              <Avatar size="sm" className="bg-porcelain/15">
                <Avatar.Fallback className="bg-transparent text-porcelain">
                  {displayName.slice(0, 1)}
                </Avatar.Fallback>
              </Avatar>
            </Button>
            <Dropdown.Popover placement="right bottom">
              <Dropdown.Menu
                aria-label="用户操作"
                onAction={(key) => {
                  if (key === 'logout') onLogout()
                }}
              >
                <Dropdown.Item id="profile" textValue={displayName}>
                  <Label>{displayName}</Label>
                  <Description>{user?.username}</Description>
                </Dropdown.Item>
                <Dropdown.Item id="logout" textValue="退出登录" variant="danger">
                  <Label>退出登录</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </nav>

      {/* 第二列:二级菜单面板 */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-ink-900/10">
        <div className="px-6 pb-2 pt-7">
          <p className="font-brand text-lg tracking-wide">{activeModule.label}</p>
          <p className="mt-1 text-xs text-ink-500/70">{activeModule.description}</p>
        </div>
        <ScrollShadow className="flex-1 px-3 pb-6">
          {activeModule.groups.map((g, i) => (
            <div key={g.label ?? i} className="mt-5 first:mt-3">
              {g.label && (
                <p className="px-3 pb-2 text-[11px] tracking-[0.2em] text-ink-500/60">
                  {g.label}
                </p>
              )}
              <ul className="flex flex-col gap-1">
                {g.items.map((it) => {
                  const active = isPathActive(pathname, it.path)
                  return (
                    <li key={it.path}>
                      <Link
                        to={it.path}
                        aria-current={active ? 'page' : undefined}
                        className={`flex h-9 items-center rounded-lg px-3 text-sm ${
                          active
                            ? 'bg-white font-medium text-ink-900 shadow-sm'
                            : 'text-ink-900/65 hover:bg-ink-900/5'
                        }`}
                      >
                        {it.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </ScrollShadow>
      </aside>

      {/* 内容列:顶栏 + 页面 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center border-b border-ink-900/10 px-8">
          <Breadcrumbs>
            {crumbs.map((c) => (
              <Breadcrumbs.Item key={c}>{c}</Breadcrumbs.Item>
            ))}
          </Breadcrumbs>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-8 pb-16 pt-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
