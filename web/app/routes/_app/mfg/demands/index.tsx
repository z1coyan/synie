import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(需求行,行级明细主视图)
export const Route = createFileRoute('/_app/mfg/demands/')({
  beforeLoad: () => {
    throw redirect({ to: '/mfg/demands/items' })
  },
})
