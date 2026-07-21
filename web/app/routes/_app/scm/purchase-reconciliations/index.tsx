import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/scm/purchase-reconciliations/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/purchase-reconciliations/items' })
  },
})
