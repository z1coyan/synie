import { createFileRoute, redirect } from '@tanstack/react-router'

/** 销售对账不再提供条目视角;旧链接落到对账单列表 */
export const Route = createFileRoute('/_app/sales/reconciliations/items')({
  beforeLoad: () => {
    throw redirect({ to: '/sales/reconciliations' })
  },
})
