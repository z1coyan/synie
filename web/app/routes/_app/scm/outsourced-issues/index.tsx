import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/scm/outsourced-issues/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/outsourced-issues/items' })
  },
})
