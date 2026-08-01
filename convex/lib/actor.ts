import type { GenericCtx } from '@convex-dev/better-auth'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import { authComponent } from '../auth'
import { synieError } from './errors'

export type Actor = {
  userId: Id<'appUsers'>
  username: string
  name: string | null
  superAdmin: boolean
  allCompanies: boolean
  permissions: ReadonlySet<string>
  companyIds: readonly string[]
}

export async function requireIdentity(ctx: GenericCtx<DataModel>): Promise<string> {
  const authUser = await authComponent.safeGetAuthUser(ctx)
  if (!authUser) throw synieError('unauthorized', '登录状态已失效,请重新登录')
  return authUser._id
}

type ActorCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

export type ActorRoleGrant = {
  enabled: boolean
  permissions: readonly string[]
}

export function actorFromRows(
  appUser: Doc<'appUsers'> | null,
  roleGrants: readonly ActorRoleGrant[],
  companyIds: readonly string[],
): Actor {
  if (!appUser?.enabled) throw synieError('unauthorized', '登录状态已失效,请重新登录')
  const permissions = new Set<string>()
  for (const grant of roleGrants) {
    if (!grant.enabled) continue
    for (const permission of grant.permissions) permissions.add(permission)
  }
  return {
    userId: appUser._id,
    username: appUser.username,
    name: appUser.name,
    superAdmin: appUser.superAdmin,
    allCompanies: appUser.allCompanies,
    permissions,
    companyIds: [...new Set(companyIds)].sort(),
  }
}

export async function actorForAppUser(ctx: ActorCtx, userId: Id<'appUsers'>): Promise<Actor> {
  const appUser = await ctx.db.get(userId)
  if (!appUser?.enabled) throw synieError('unauthorized', '登录状态已失效,请重新登录')
  const [roleAssignments, companyAssignments] = await Promise.all([
    ctx.db
      .query('iamUserRoles')
      .withIndex('by_user', (query) => query.eq('userId', appUser._id))
      .collect(),
    ctx.db
      .query('iamUserCompanies')
      .withIndex('by_user', (query) => query.eq('userId', appUser._id))
      .collect(),
  ])

  const roleGrants: ActorRoleGrant[] = []
  for (const assignment of roleAssignments) {
    const role = await ctx.db.get(assignment.roleId)
    if (!role) continue
    const rows = await ctx.db
      .query('iamRolePermissions')
      .withIndex('by_role', (query) => query.eq('roleId', role._id))
      .collect()
    roleGrants.push({
      enabled: role.enabled,
      permissions: rows.map((row) => row.permission),
    })
  }
  return actorFromRows(
    appUser,
    roleGrants,
    companyAssignments.map((assignment) => assignment.companyId),
  )
}

export async function requireActor(ctx: ActorCtx): Promise<Actor> {
  const authUserId = await requireIdentity(ctx)
  const appUser = await ctx.db
    .query('appUsers')
    .withIndex('by_auth_user', (query) => query.eq('authUserId', authUserId))
    .unique()
  if (!appUser) throw synieError('unauthorized', '登录状态已失效,请重新登录')
  return actorForAppUser(ctx, appUser._id)
}
