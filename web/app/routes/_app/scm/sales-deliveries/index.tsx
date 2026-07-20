import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/scm/sales-deliveries/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/sales-deliveries/items' })
  },
})
