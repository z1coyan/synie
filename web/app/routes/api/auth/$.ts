import { createFileRoute } from '@tanstack/react-router'
import { handleConvexAuthRequest } from '~/lib/auth-runtime.server'

const proxy = ({ request }: { request: Request }) =>
  handleConvexAuthRequest(request)

/** Better Auth cookie 只通过 TanStack Start 同源入口往返。 */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: proxy,
      POST: proxy,
    },
  },
})
