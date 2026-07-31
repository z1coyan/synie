import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/mfg/outputs/')({
  beforeLoad: () => {
    throw redirect({ to: '/mfg/outputs/items' })
  },
})
