import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(报价条目,行级明细主视图)
export const Route = createFileRoute('/_app/scm/purchase-quotations/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/purchase-quotations/items' })
  },
})
