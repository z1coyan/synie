import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ConvexSetupPage } from '~/components/convex-setup-page'
import { api } from '~/lib/convex-api'

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.setup.status.get, {}),
    )
    if (!status.initialized) return

    if (context.authToken) {
      let hasActor = false
      try {
        await context.queryClient.ensureQueryData(convexQuery(api.iam.me.get, {}))
        hasActor = true
      } catch {}
      if (hasActor) throw redirect({ to: '/' })
    }
    throw redirect({ to: '/login' })
  },
  component: ConvexSetupPage,
})
