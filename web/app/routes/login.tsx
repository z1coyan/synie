import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ConvexLoginPage } from '~/components/convex-login-page'
import { api } from '~/lib/convex-api'
import { shouldRedirectLoginToSetup } from '~/lib/setup-navigation'

export const Route = createFileRoute('/login')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.setup.status.get, {}),
    )
    if (shouldRedirectLoginToSetup(status)) throw redirect({ to: '/setup' })

    if (context.authToken) {
      let hasActor = false
      try {
        await context.queryClient.ensureQueryData(convexQuery(api.iam.me.get, {}))
        hasActor = true
      } catch {
        // 无 Actor 或失效 session 留在登录页。
      }
      if (hasActor) throw redirect({ to: '/' })
    }
  },
  component: ConvexLoginPage,
})
