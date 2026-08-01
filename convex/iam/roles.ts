import { v } from 'convex/values'
import { permissionedMutation } from '../lib/auth'
import { synieError, validationError } from '../lib/errors'

function requiredBounded(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || [...normalized].length > 64) {
    throw validationError('角色参数不合法', {
      [field]: ['不能为空且长度不能超过 64'],
    })
  }
  return normalized
}

function normalizePermissions(values: readonly string[]): string[] {
  const permissions = new Set<string>()
  for (const raw of values) {
    const permission = raw.trim()
    if (!permission || permission.length > 160 || /\s/.test(permission)) {
      throw validationError('权限码不合法', { permissions: ['包含格式不合法的权限码'] })
    }
    permissions.add(permission)
  }
  return [...permissions].sort()
}

export const create = permissionedMutation('sys.role:create')({
  args: {
    code: v.string(),
    name: v.string(),
    enabled: v.optional(v.boolean()),
  },
  returns: v.object({
    id: v.id('iamRoles'),
    code: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    builtin: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const code = requiredBounded(args.code, 'code')
    const name = requiredBounded(args.name, 'name')
    const existing = await ctx.db
      .query('iamRoles')
      .withIndex('by_code', (query) => query.eq('code', code))
      .unique()
    if (existing) throw synieError('conflict', '角色编码已存在')

    const enabled = args.enabled ?? true
    const now = Date.now()
    const id = await ctx.db.insert('iamRoles', {
      code,
      name,
      enabled,
      builtin: false,
      insertedAt: now,
      updatedAt: now,
    })
    return { id, code, name, enabled, builtin: false }
  },
})

export const update = permissionedMutation('sys.role:update')({
  args: {
    id: v.id('iamRoles'),
    name: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.object({
    id: v.id('iamRoles'),
    code: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    builtin: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.id)
    if (!role) throw synieError('not_found', '角色不存在')
    if (role.builtin) throw synieError('conflict', '内置角色不可修改或删除')
    const name = args.name === undefined ? role.name : requiredBounded(args.name, 'name')
    const enabled = args.enabled ?? role.enabled
    await ctx.db.patch(role._id, { name, enabled, updatedAt: Date.now() })
    return { id: role._id, code: role.code, name, enabled, builtin: role.builtin }
  },
})

export const syncPermissions = permissionedMutation('sys.role:update')({
  args: { id: v.id('iamRoles'), permissions: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.id)
    if (!role) throw synieError('not_found', '角色不存在')
    if (role.builtin) throw synieError('conflict', '内置角色的授权不可增删')
    const permissions = normalizePermissions(args.permissions)
    const existing = await ctx.db
      .query('iamRolePermissions')
      .withIndex('by_role', (query) => query.eq('roleId', role._id))
      .collect()
    for (const row of existing) await ctx.db.delete(row._id)
    for (const permission of permissions) {
      await ctx.db.insert('iamRolePermissions', { roleId: role._id, permission, insertedAt: Date.now() })
    }
    return permissions
  },
})

export const remove = permissionedMutation('sys.role:delete')({
  args: { id: v.id('iamRoles') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.id)
    if (!role) throw synieError('not_found', '角色不存在')
    if (role.builtin) throw synieError('conflict', '内置角色不可修改或删除')
    const [permissions, assignments] = await Promise.all([
      ctx.db
        .query('iamRolePermissions')
        .withIndex('by_role', (query) => query.eq('roleId', role._id))
        .collect(),
      ctx.db
        .query('iamUserRoles')
        .withIndex('by_role', (query) => query.eq('roleId', role._id))
        .collect(),
    ])
    for (const row of permissions) await ctx.db.delete(row._id)
    for (const row of assignments) await ctx.db.delete(row._id)
    await ctx.db.delete(role._id)
    return null
  },
})
