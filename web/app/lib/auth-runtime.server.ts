import '@tanstack/react-start/server-only'
import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start'
import { getConvexEnvironment } from './convex'

type ConvexAuthRuntime = ReturnType<typeof convexBetterAuthReactStart>

let runtime: ConvexAuthRuntime | undefined

export function getConvexAuthRuntime(): ConvexAuthRuntime {
  if (!runtime) {
    const env = getConvexEnvironment()
    runtime = convexBetterAuthReactStart({
      convexUrl: env.url,
      convexSiteUrl: env.siteUrl,
    })
  }
  return runtime
}

export function handleConvexAuthRequest(request: Request): Promise<Response> {
  return getConvexAuthRuntime().handler(request)
}
