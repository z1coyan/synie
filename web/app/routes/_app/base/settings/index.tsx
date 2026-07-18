import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(行情拉取)
export const Route = createFileRoute('/_app/base/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/base/settings/market-fetch' })
  },
})
