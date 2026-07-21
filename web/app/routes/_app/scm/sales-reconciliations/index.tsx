import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/scm/sales-reconciliations/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/sales-reconciliations/items' })
  },
})
