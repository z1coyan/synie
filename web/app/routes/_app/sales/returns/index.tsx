import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/sales/returns/')({
  beforeLoad: () => {
    throw redirect({ to: '/sales/returns/items' })
  },
})
