import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/purchase/outsourced-issues/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/outsourced-issues/items' })
  },
})
