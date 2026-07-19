import { createFileRoute, redirect } from '@tanstack/react-router'

// 旧入口重定向:其他库存单 → 盘点 tab
export const Route = createFileRoute('/_app/scm/stock-counts')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/other-stock/counts' })
  },
})
