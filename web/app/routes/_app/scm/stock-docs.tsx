import { createFileRoute, redirect } from '@tanstack/react-router'

// 旧入口重定向:其他库存单 → 出入库 tab
export const Route = createFileRoute('/_app/scm/stock-docs')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/other-stock/docs' })
  },
})
