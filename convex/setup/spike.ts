import { v } from 'convex/values'
import { mutation, query } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { synieError } from '../lib/errors'
import { normalizeUsername } from '../lib/username'
import { createFirstUserTransaction, type SetupFaultPoint } from './core'

declare const process: { env: Record<string, string | undefined> }

const faultPointValidator = v.union(
  v.literal('after_auth_user'),
  v.literal('after_credential'),
  v.literal('after_app_user'),
  v.literal('after_setup_state'),
)

function equalSecret(candidate: string, expected: string): boolean {
  const candidateBytes = new TextEncoder().encode(candidate)
  const expectedBytes = new TextEncoder().encode(expected)
  const comparedLength = Math.max(candidateBytes.length, expectedBytes.length)
  let difference = candidateBytes.length ^ expectedBytes.length
  for (let index = 0; index < comparedLength; index += 1) {
    difference |= (candidateBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0)
  }
  return difference === 0
}

function requireSpikeSecret(candidate: string): void {
  const expected = process.env.SYNIE_AUTH_SPIKE_SECRET
  if (!expected || !equalSecret(candidate, expected)) {
    throw synieError('forbidden', '认证事务测试入口不可用')
  }
}

/** Test-only top-level mutation. Never enable without a deployment secret. */
export const createFirstUserWithFault = mutation({
  args: {
    spikeSecret: v.string(),
    faultPoint: faultPointValidator,
    username: v.string(),
    password: v.string(),
    name: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    user: v.object({
      id: v.id('appUsers'),
      username: v.string(),
      name: v.union(v.string(), v.null()),
    }),
  }),
  handler: async (ctx, args) => {
    requireSpikeSecret(args.spikeSecret)
    return createFirstUserTransaction(ctx, args, {
      faultPoint: args.faultPoint as SetupFaultPoint,
    })
  },
})

const inspectionResult = v.object({
  authUserExists: v.boolean(),
  credentialExists: v.boolean(),
  appUserExists: v.boolean(),
  setupStateExists: v.boolean(),
  authStoreEmpty: v.boolean(),
  appStoreEmpty: v.boolean(),
  authStoreSingleton: v.boolean(),
  appStoreSingleton: v.boolean(),
  authUserLinkedToAppUser: v.boolean(),
  setupStateLinkedToAppUser: v.boolean(),
  clean: v.boolean(),
})

/**
 * Secret-gated structural check for the real component and application tables.
 * Deliberately returns no user id, email, credential, session, or secret material.
 */
export const inspect = query({
  args: { spikeSecret: v.string(), username: v.string() },
  returns: inspectionResult,
  handler: async (ctx, args) => {
    requireSpikeSecret(args.spikeSecret)
    const usernameKey = normalizeUsername(args.username)
    const auth = createAuth(ctx)
    const adapter = authComponent.adapter(ctx)(auth.options)

    const [authUser, anyAuthUsers, anyCredentials, appUsers, setupStates, anyAppUsers] =
      await Promise.all([
        adapter.findOne<{ id: string; userId?: string | null }>({
          model: 'user',
          where: [{ field: 'username', value: usernameKey }],
        }),
        adapter.findMany({ model: 'user', limit: 2 }),
        adapter.findMany({
          model: 'account',
          where: [{ field: 'providerId', value: 'credential' }],
          limit: 2,
        }),
        ctx.db
          .query('appUsers')
          .withIndex('by_username_key', (index) => index.eq('usernameKey', usernameKey))
          .collect(),
        ctx.db
          .query('setupState')
          .withIndex('by_key', (index) => index.eq('key', 'singleton'))
          .collect(),
        ctx.db.query('appUsers').take(2),
      ])

    const credential = authUser
      ? await adapter.findOne<{ id: string }>({
          model: 'account',
          where: [
            { field: 'userId', value: authUser.id },
            { field: 'providerId', value: 'credential' },
          ],
        })
      : null
    const appUser = appUsers[0] ?? null
    const setupState = setupStates[0] ?? null
    const authUserExists = authUser !== null
    const credentialExists = credential !== null
    const appUserExists = appUser !== null
    const setupStateExists = setupState !== null
    const authStoreEmpty = anyAuthUsers.length === 0 && anyCredentials.length === 0
    const appStoreEmpty = anyAppUsers.length === 0 && setupStates.length === 0
    const authStoreSingleton = anyAuthUsers.length === 1 && anyCredentials.length === 1
    const appStoreSingleton = anyAppUsers.length === 1 && setupStates.length === 1

    return {
      authUserExists,
      credentialExists,
      appUserExists,
      setupStateExists,
      authStoreEmpty,
      appStoreEmpty,
      authStoreSingleton,
      appStoreSingleton,
      authUserLinkedToAppUser:
        authUser !== null && appUser !== null && authUser.userId === appUser._id,
      setupStateLinkedToAppUser:
        setupState !== null && appUser !== null && setupState.firstAdminUserId === appUser._id,
      clean:
        !authUserExists &&
        !credentialExists &&
        !appUserExists &&
        !setupStateExists &&
        authStoreEmpty &&
        appStoreEmpty,
    }
  },
})
