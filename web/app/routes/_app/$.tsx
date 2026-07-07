import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { Button } from '@heroui/react'
import { itemForPath } from '~/lib/menu'

/** 所有尚未实现的菜单项统一落到这个占位模板页 */
export const Route = createFileRoute('/_app/$')({
  component: PlaceholderPage,
})

function PlaceholderPage() {
  const pathname = useLocation({ select: (l) => l.pathname })
  const navigate = useNavigate()
  const item = itemForPath(pathname)

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <p className="text-xs tracking-[0.4em] text-ink-500/50">UNDER CONSTRUCTION</p>
      <h1 className="mt-4 font-brand text-3xl tracking-wide">
        「{item?.label ?? '该页面'}」建设中
      </h1>
      <p className="mt-3 text-sm text-ink-500">
        页面骨架已就绪,业务功能将在后续迭代中上线。
      </p>
      <Button
        variant="outline"
        className="mt-8 border-ink-900/25"
        onPress={() => navigate({ to: '/' })}
      >
        返回工作台
      </Button>
    </div>
  )
}
