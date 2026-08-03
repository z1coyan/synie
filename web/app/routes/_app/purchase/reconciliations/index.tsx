import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/purchase/reconciliations/')({
  beforeLoad: () => {
    throw redirect({ to: '/purchase/reconciliations/items' })
  },
})
