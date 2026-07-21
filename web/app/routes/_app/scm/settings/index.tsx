import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(销售)
export const Route = createFileRoute('/_app/scm/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/settings/sales' })
  },
})
