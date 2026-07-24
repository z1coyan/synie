import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/scm/outsourced-receipts/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/outsourced-receipts/items' })
  },
})
