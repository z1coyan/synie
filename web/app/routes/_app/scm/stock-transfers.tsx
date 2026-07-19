import { createFileRoute, redirect } from '@tanstack/react-router'

// 旧入口重定向:其他库存单 → 调拨 tab
export const Route = createFileRoute('/_app/scm/stock-transfers')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/other-stock/transfers' })
  },
})
