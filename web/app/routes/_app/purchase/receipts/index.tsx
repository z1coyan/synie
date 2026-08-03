import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/purchase/receipts/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/receipts/items' })
  },
})
