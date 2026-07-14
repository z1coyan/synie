import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(承兑交易,日常录入/审核主动线)
export const Route = createFileRoute('/_app/finance/acceptance/')({
  beforeLoad: () => {
    throw redirect({ to: '/finance/acceptance/transactions' })
  },
})
