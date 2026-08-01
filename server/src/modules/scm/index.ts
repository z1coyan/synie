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

export function registerScmResources(registry: Registry): void {
  registry.register(orderFlowItemMeta())
}

export function createScmServices(db: Kysely<Database>) {
  return { orderFlow: createOrderFlowService(db) }
}

export type ScmServices = ReturnType<typeof createScmServices>

export function scmRouteMounts(deps: { auth: AuthService; scm: ScmServices }) {
  return {
    orderFlowItems: orderFlowRoutes({ auth: deps.auth, orderFlow: deps.scm.orderFlow }),
  }
}

export type { OrderFlowService }
