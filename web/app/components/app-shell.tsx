import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Accordion,
  Avatar,
  Breadcrumbs,
  Button,
  Description,
  Drawer,
  Dropdown,
  Label,
  ScrollShadow,
  Tooltip,
} from '@heroui/react'
import { AppearanceSwitch } from '~/components/appearance-switch'
import { IconMenu } from '~/components/icons'
import {
  isPathActive,
  itemForPath,
  menuModules,
  moduleForPath,
} from '~/lib/menu'

interface ShellUser {
  username: string
  name: string | null
}

interface AppShellProps {
  user: ShellUser | null
  onLogout: () => void
  children: ReactNode
}

/**
 * 双列菜单布局:左侧模块图标栏 + 二级菜单面板 + 顶栏 + 内容区。
 * lg 以下收起两列,顶栏汉堡按钮打开抽屉菜单。
 */
export function AppShell({ user, onLogout, children }: AppShellProps) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
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
      {/* 第一列:模块图标栏(仅桌面) — 品牌仪式面,恒定玄蓝 */}
      <nav
        aria-label="模块导航"
        className="hidden w-16 shrink-0 flex-col items-center bg-brand-ink py-5 text-brand-porcelain lg:flex"
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
                      ? 'bg-brand-porcelain/15 text-brand-porcelain hover:bg-brand-porcelain/15'
                      : 'text-brand-porcelain/45 hover:bg-brand-porcelain/10 hover:text-brand-porcelain/90'
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
          <UserMenu
            displayName={displayName}
            username={user?.username}
            onLogout={onLogout}
            placement="right bottom"
            avatarClassName="bg-brand-porcelain/15"
            fallbackClassName="bg-transparent text-brand-porcelain"
          />
        </div>
      </nav>

      {/* 第二列:二级菜单面板(仅桌面) — 跟随外观 */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-ink-900/10 lg:flex">
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
                {g.items.map((it) => (
                  <li key={it.path}>
                    <MenuLink item={it} pathname={pathname} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </ScrollShadow>
      </aside>

      {/* 内容列:顶栏 + 页面 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-ink-900/10 px-4 lg:px-8">
          <Button
            isIconOnly
            variant="ghost"
            aria-label="打开菜单"
            onPress={() => setMenuOpen(true)}
            className="-ml-1 text-ink-900/70 lg:hidden"
          >
            <IconMenu className="h-5 w-5" />
          </Button>
          <Breadcrumbs>
            {crumbs.map((c) => (
              <Breadcrumbs.Item key={c}>{c}</Breadcrumbs.Item>
            ))}
          </Breadcrumbs>
          <div className="ml-auto lg:hidden">
            <UserMenu
              displayName={displayName}
              username={user?.username}
              onLogout={onLogout}
              placement="bottom end"
              avatarClassName="bg-ink-900/10"
              fallbackClassName="bg-transparent text-ink-900"
            />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full px-4 pb-16 pt-8 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>

      {/* 移动端抽屉菜单 */}
      <Drawer.Backdrop isOpen={menuOpen} onOpenChange={setMenuOpen}>
        <Drawer.Content placement="left">
          <Drawer.Dialog
            aria-label="导航菜单"
            className="w-72 max-w-[85vw] bg-porcelain"
          >
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="flex items-baseline gap-2">
                <span className="font-brand text-xl tracking-wide">Synie</span>
                <span className="text-xs tracking-[0.3em] text-ink-500/70">
                  企业资源管理系统
                </span>
              </Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <nav aria-label="全部菜单">
                <Accordion hideSeparator defaultExpandedKeys={[activeModule.key]}>
                  {menuModules.map((m) => (
                    <Accordion.Item key={m.key} id={m.key}>
                      <Accordion.Heading>
                        <Accordion.Trigger className="text-sm">
                          <m.icon className="mr-3 h-4 w-4 shrink-0 text-ink-500/70" />
                          {m.label}
                          <Accordion.Indicator />
                        </Accordion.Trigger>
                      </Accordion.Heading>
                      <Accordion.Panel>
                        <Accordion.Body className="pt-0">
                          <ul className="flex flex-col gap-1">
                            {m.groups
                              .flatMap((g) => g.items)
                              .map((it) => (
                                <li key={it.path}>
                                  <MenuLink
                                    item={it}
                                    pathname={pathname}
                                    onNavigate={() => setMenuOpen(false)}
                                  />
                                </li>
                              ))}
                          </ul>
                        </Accordion.Body>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
              </nav>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </div>
  )
}

/** 二级菜单/抽屉共用的菜单项 */
function MenuLink({
  item,
  pathname,
  onNavigate,
}: {
  item: { label: string; path: string }
  pathname: string
  onNavigate?: () => void
}) {
  const active = isPathActive(pathname, item.path)
  return (
    <Link
      to={item.path}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={`flex h-9 items-center rounded-lg px-3 text-sm ${
        active
          ? 'bg-ink-900/8 font-medium text-ink-900 shadow-sm dark:bg-brand-porcelain/10 dark:shadow-none'
          : 'text-ink-900/65 hover:bg-ink-900/5'
      }`}
    >
      {item.label}
    </Link>
  )
}

/** 头像 + 用户下拉(桌面在图标栏底部,移动端在顶栏右侧);含外观模式三选一 */
function UserMenu({
  displayName,
  username,
  onLogout,
  placement,
  avatarClassName,
  fallbackClassName,
}: {
  displayName: string
  username?: string
  onLogout: () => void
  placement: 'right bottom' | 'bottom end'
  avatarClassName: string
  fallbackClassName: string
}) {
  return (
    <Dropdown>
      <Button
        isIconOnly
        variant="ghost"
        aria-label="用户菜单"
        className="h-10 w-10 rounded-full"
      >
        <Avatar size="sm" className={avatarClassName}>
          <Avatar.Fallback className={fallbackClassName}>
            {displayName.slice(0, 1)}
          </Avatar.Fallback>
        </Avatar>
      </Button>
      <Dropdown.Popover placement={placement} className="min-w-52">
        <div className="border-b border-ink-900/10 px-3 py-2.5">
          <p className="mb-1.5 text-[11px] tracking-wide text-ink-500">外观</p>
          <AppearanceSwitch size="sm" className="w-full justify-between" />
        </div>
        <Dropdown.Menu
          aria-label="用户操作"
          onAction={(key) => {
            if (key === 'logout') onLogout()
          }}
        >
          <Dropdown.Item id="profile" textValue={displayName}>
            <Label>{displayName}</Label>
            <Description>{username}</Description>
          </Dropdown.Item>
          <Dropdown.Item id="logout" textValue="退出登录" variant="danger">
            <Label>退出登录</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
