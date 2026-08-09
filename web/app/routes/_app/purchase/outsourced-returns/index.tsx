import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/purchase/outsourced-returns/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/outsourced-returns/items' })
  },
})
