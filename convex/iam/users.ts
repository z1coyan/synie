import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { permissionedMutation } from '../lib/auth'
import { synieError, validationError } from '../lib/errors'
import {
  createOneTimePassword,
  normalizeCompanyIds,
  prepareManagedUser,
} from './model'
import {
  createPasswordPrincipal,
  deletePrincipal,
  resetPrincipalPassword,
} from './principal'

const managedUserResult = v.object({
  user: v.object({
    id: v.id('appUsers'),
    username: v.string(),
    name: v.union(v.string(), v.null()),
  }),
  password: v.string(),
})

async function validateRoleIds(
  ctx: Pick<MutationCtx, 'db'>,
  roleIds: readonly Id<'iamRoles'>[],
): Promise<Id<'iamRoles'>[]> {
  const unique = [...new Set(roleIds)].sort()
  for (const roleId of unique) {
    if (!(await ctx.db.get(roleId))) {
      throw validationError('用户参数不合法', { roleIds: ['包含不存在的角色'] })
    }
  }
  return unique
}

export const create = permissionedMutation('sys.user:create')({
  args: {
    username: v.string(),
    name: v.optional(v.union(v.string(), v.null())),
    roleIds: v.optional(v.array(v.id('iamRoles'))),
    companyIds: v.optional(v.array(v.string())),
  },
  returns: managedUserResult,
  handler: async (ctx, args) => {
    const prepared = prepareManagedUser(args)
    if (!prepared.ok) throw validationError('用户参数不合法', prepared.fields)

    const existing = await ctx.db
      .query('appUsers')
      .withIndex('by_username_key', (query) =>
        query.eq('usernameKey', prepared.value.usernameKey),
      )
      .unique()
    if (existing) throw synieError('conflict', '用户名已存在')

    const roleIds = await validateRoleIds(ctx, args.roleIds ?? [])
    const companyIds = normalizeCompanyIds(args.companyIds ?? [])
    const password = createOneTimePassword()

    let signup: Awaited<ReturnType<typeof createPasswordPrincipal>>
    try {
      signup = await createPasswordPrincipal(ctx, {
        ...prepared.value,
        password,
      })
    } catch {
      throw synieError('internal', '创建用户失败')
    }

    const now = Date.now()
    const userId = await ctx.db.insert('appUsers', {
      authUserId: signup.user.id,
      usernameKey: prepared.value.usernameKey,
      username: prepared.value.username,
      name: prepared.value.name,
      enabled: true,
      superAdmin: false,
      allCompanies: false,
      insertedAt: now,
      updatedAt: now,
    })
    await authComponent.setUserId(ctx, signup.user.id, userId)
    await replaceUserAccess(ctx, userId, roleIds, companyIds)

    return {
      user: { id: userId, username: prepared.value.username, name: prepared.value.name },
      password,
    }
  },
})

export const update = permissionedMutation('sys.user:update')({
  args: {
    id: v.id('appUsers'),
    name: v.optional(v.union(v.string(), v.null())),
    roleIds: v.optional(v.array(v.id('iamRoles'))),
    companyIds: v.optional(v.array(v.string())),
  },
  returns: v.object({
    id: v.id('appUsers'),
    username: v.string(),
    name: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id)
    if (!user) throw synieError('not_found', '用户不存在')

    let name = user.name
    if (args.name !== undefined) {
      name = args.name == null ? null : args.name.trim() || null
      if (name != null && [...name].length > 64) {
        throw validationError('用户参数不合法', { name: ['长度不能超过 64'] })
      }
      await ctx.db.patch(user._id, { name, updatedAt: Date.now() })
    }

    const roleIds =
      args.roleIds === undefined ? null : await validateRoleIds(ctx, args.roleIds)
    const companyIds =
      args.companyIds === undefined ? null : normalizeCompanyIds(args.companyIds)
    if (roleIds !== null || companyIds !== null) {
      const existingRoles = await ctx.db
        .query('iamUserRoles')
        .withIndex('by_user', (query) => query.eq('userId', user._id))
        .collect()
      const existingCompanies = await ctx.db
        .query('iamUserCompanies')
        .withIndex('by_user', (query) => query.eq('userId', user._id))
        .collect()
      await replaceUserAccess(
        ctx,
        user._id,
        roleIds ?? existingRoles.map((row) => row.roleId),
        companyIds ?? existingCompanies.map((row) => row.companyId),
      )
    }

    return { id: user._id, username: user.username, name }
  },
})

export const resetPassword = permissionedMutation('sys.user:update')({
  args: { id: v.id('appUsers') },
  returns: v.object({ password: v.string() }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id)
    if (!user) throw synieError('not_found', '用户不存在')
    const password = createOneTimePassword()
    await resetPrincipalPassword(ctx, user.authUserId, password)
    return { password }
  },
})

export const remove = permissionedMutation('sys.user:delete')({
  args: { id: v.id('appUsers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id)
    if (!user) throw synieError('not_found', '用户不存在')

    const [roles, companies] = await Promise.all([
      ctx.db
        .query('iamUserRoles')
        .withIndex('by_user', (query) => query.eq('userId', user._id))
        .collect(),
      ctx.db
        .query('iamUserCompanies')
        .withIndex('by_user', (query) => query.eq('userId', user._id))
        .collect(),
    ])
    for (const row of roles) await ctx.db.delete(row._id)
    for (const row of companies) await ctx.db.delete(row._id)
    await deletePrincipal(ctx, user.authUserId)
    await ctx.db.delete(user._id)
    return null
  },
})

async function replaceUserAccess(
  ctx: MutationCtx,
  userId: Id<'appUsers'>,
  roleIds: readonly Id<'iamRoles'>[],
  companyIds: readonly string[],
): Promise<void> {
  const [roles, companies] = await Promise.all([
    ctx.db
      .query('iamUserRoles')
      .withIndex('by_user', (query) => query.eq('userId', userId))
      .collect(),
    ctx.db
      .query('iamUserCompanies')
      .withIndex('by_user', (query) => query.eq('userId', userId))
      .collect(),
  ])
  for (const row of roles) await ctx.db.delete(row._id)
  for (const row of companies) await ctx.db.delete(row._id)
  for (const roleId of roleIds) await ctx.db.insert('iamUserRoles', { userId, roleId })
  for (const companyId of companyIds) {
    await ctx.db.insert('iamUserCompanies', { userId, companyId })
  }
}
