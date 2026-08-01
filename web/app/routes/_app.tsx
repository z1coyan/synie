import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ConvexAppShell } from '~/components/convex-app-shell'
import { api } from '~/lib/convex-api'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.setup.status.get, {}),
    )
    if (!status.initialized) throw redirect({ to: '/setup' })
    if (!context.authToken) throw redirect({ to: '/login' })

    try {
      await context.queryClient.ensureQueryData(convexQuery(api.iam.me.get, {}))
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: ConvexAppShell,
})
