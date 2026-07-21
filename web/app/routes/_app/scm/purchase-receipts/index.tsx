import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/scm/purchase-receipts/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/purchase-receipts/items' })
  },
})
