import { hashPassword } from 'better-auth/crypto'
import type { MutationCtx } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { synieError } from '../lib/errors'
import { createInternalEmail } from '../setup/model'

type PrincipalInput = {
  username: string
  usernameKey: string
  name: string | null
  password: string
}

type PrincipalCreationOptions = {
  faultPoint?: 'after_auth_user' | 'after_credential'
}

/**
 * The caller must be a top-level mutation. Component and application writes
 * then share the same Convex transaction and roll back together.
 */
export async function createPasswordPrincipal(
  ctx: MutationCtx,
  input: PrincipalInput,
  options: PrincipalCreationOptions = {},
) {
  const auth = createAuth(ctx, {
    allowUserCreation: true,
    faultPoint: options.faultPoint,
  })
  return auth.api.signUpEmail({
    body: {
      email: createInternalEmail(),
      password: input.password,
      name: input.name || input.username,
      username: input.usernameKey,
      displayUsername: input.username,
    },
  })
}

export async function resetPrincipalPassword(
  ctx: MutationCtx,
  authUserId: string,
  password: string,
): Promise<void> {
  const auth = createAuth(ctx)
  const adapter = authComponent.adapter(ctx)(auth.options)
  const account = await adapter.findOne({
    model: 'account',
    where: [
      { field: 'userId', value: authUserId },
      { field: 'providerId', value: 'credential' },
    ],
  })
  if (!account) throw synieError('internal', '用户认证凭证不存在')

  const updated = await adapter.update({
    model: 'account',
    where: [
      { field: 'userId', value: authUserId },
      { field: 'providerId', value: 'credential' },
    ],
    update: { password: await hashPassword(password) },
  })
  if (!updated) throw synieError('internal', '重置用户密码失败')

  // A reset invalidates every existing device, including the target user's
  // current browser session. The one-time password is the only recovery path.
  await adapter.deleteMany({
    model: 'session',
    where: [{ field: 'userId', value: authUserId }],
  })
}

export async function deletePrincipal(ctx: MutationCtx, authUserId: string): Promise<void> {
  const auth = createAuth(ctx)
  const adapter = authComponent.adapter(ctx)(auth.options)
  await adapter.deleteMany({
    model: 'session',
    where: [{ field: 'userId', value: authUserId }],
  })
  await adapter.deleteMany({
    model: 'account',
    where: [{ field: 'userId', value: authUserId }],
  })
  await adapter.delete({
    model: 'user',
    where: [{ field: 'id', value: authUserId }],
  })
}
