import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/purchase/returns/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/returns/items' })
  },
})
