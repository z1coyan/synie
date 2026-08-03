import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(订单条目,行级明细主视图)
export const Route = createFileRoute('/_app/purchase/orders/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/orders/items' })
  },
})
