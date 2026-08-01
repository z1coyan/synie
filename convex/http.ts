import { httpRouter } from 'convex/server'
import { authComponent, createAuth } from './auth'

const http = httpRouter()

// Browser auth is same-origin through TanStack Start; direct signup remains denied
// by createAuth's trusted user-create hook.
authComponent.registerRoutesLazy(http, createAuth)

export default http
