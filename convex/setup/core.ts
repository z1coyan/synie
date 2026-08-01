import type { MutationCtx } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { createPasswordPrincipal } from '../iam/principal'
import { synieError, validationError } from '../lib/errors'
import { prepareFirstUser, type FirstUserInput } from './model'
import { readSetupPresence } from './state'
import { seedCommonCurrencies } from './seeds'

export const setupFaultPoints = [
  'after_auth_user',
  'after_credential',
  'after_app_user',
  'after_setup_state',
] as const

export type SetupFaultPoint = (typeof setupFaultPoints)[number]

type CreateFirstUserOptions = {
  faultPoint?: SetupFaultPoint
}

function injectedFault(point: SetupFaultPoint): never {
  throw new Error(`SYNIE_SETUP_FAULT_${point.toUpperCase()}`)
}

/**
 * The caller must itself be a top-level mutation. Component writes performed by
 * Better Auth and application-table writes therefore commit or roll back as one
 * Convex transaction.
 */
export async function createFirstUserTransaction(
  ctx: MutationCtx,
  input: FirstUserInput,
  options: CreateFirstUserOptions = {},
) {
  const prepared = prepareFirstUser(input)
  if (!prepared.ok) {
    throw validationError('首个管理员参数不合法', prepared.fields)
  }

  const presence = await readSetupPresence(ctx.db)
  if (presence.initialized) throw synieError('conflict', '系统已完成初始化')
  if (presence.hasUsers) throw synieError('conflict', '已存在用户,请直接登录')

  const auth = createAuth(ctx)
  const adapter = authComponent.adapter(ctx)(auth.options)
  const existingAuthUsers = await adapter.findMany({ model: 'user', limit: 1 })
  if (existingAuthUsers.length > 0) {
    throw synieError('conflict', '已存在用户,请直接登录')
  }

  let signup: Awaited<ReturnType<typeof createPasswordPrincipal>>
  try {
    signup = await createPasswordPrincipal(ctx, prepared.value, {
      faultPoint:
        options.faultPoint === 'after_auth_user' || options.faultPoint === 'after_credential'
          ? options.faultPoint
          : undefined,
    })
  } catch (error) {
    if (
      options.faultPoint === 'after_auth_user' ||
      options.faultPoint === 'after_credential'
    ) {
      throw error
    }
    throw synieError('internal', '创建首个管理员失败')
  }

  const now = Date.now()
  const appUserId = await ctx.db.insert('appUsers', {
    authUserId: signup.user.id,
    usernameKey: prepared.value.usernameKey,
    username: prepared.value.username,
    name: prepared.value.name,
    enabled: true,
    superAdmin: true,
    allCompanies: true,
    insertedAt: now,
    updatedAt: now,
  })

  if (options.faultPoint === 'after_app_user') injectedFault(options.faultPoint)

  // Keep the component's optional reverse link in sync with the authoritative
  // appUsers.authUserId link. Any failure here aborts the whole transaction.
  await authComponent.setUserId(ctx, signup.user.id, appUserId)

  await ctx.db.insert('setupState', {
    key: 'singleton',
    authInitializedAt: now,
    firstAdminUserId: appUserId,
  })

  await seedCommonCurrencies(ctx)

  if (options.faultPoint === 'after_setup_state') injectedFault(options.faultPoint)

  return {
    user: {
      id: appUserId,
      username: prepared.value.username,
      name: prepared.value.name,
    },
  }
}
