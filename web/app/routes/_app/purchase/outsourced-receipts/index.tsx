import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/purchase/outsourced-receipts/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/outsourced-receipts/items' })
  },
})
