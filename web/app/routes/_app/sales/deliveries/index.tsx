import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/sales/deliveries/')({
  beforeLoad: () => {
    throw redirect({ to: '/sales/deliveries/items' })
  },
})
