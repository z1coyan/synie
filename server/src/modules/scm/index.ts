import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import {
  createOrderFlowService,
  orderFlowItemMeta,
  orderFlowRoutes,
  type OrderFlowService,
} from './orderflow/index.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'

export function registerScmResources(registry: Registry): void {
  registry.register(orderFlowItemMeta())
}

export function createScmServices(db: Kysely<Database>, registry: Registry) {
  return { orderFlow: createOrderFlowService(db, registry) }
}

export type ScmServices = ReturnType<typeof createScmServices>

export function scmRouteMounts(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  scm: ScmServices
}) {
  return {
    orderFlowItems: orderFlowRoutes({
      auth: deps.auth,
      authz: deps.authz,
      orderFlow: deps.scm.orderFlow,
    }),
  }
}

export type { OrderFlowService }
