import { normalizeUsername, validateUsername } from '../lib/username'

export type FirstUserInput = {
  username: string
  password: string
  name?: string | null
}

export type PreparedFirstUser = {
  username: string
  usernameKey: string
  password: string
  name: string | null
}

export type FirstUserValidation =
  | { ok: true; value: PreparedFirstUser }
  | { ok: false; fields: Record<string, string[]> }

/**
 * Validate setup input before any Better Auth/component write occurs.
 * String limits intentionally count Unicode code points, matching the legacy service.
 */
export function prepareFirstUser(input: FirstUserInput): FirstUserValidation {
  const username = input.username.trim()
  const fields: Record<string, string[]> = {}
  const usernameError = validateUsername(input.username)

  if (usernameError) fields.username = [usernameError]
  if (!input.password || input.password.length > 1024) {
    fields.password = ['不能为空且长度不能超过 1024']
  }
  if (input.name != null && [...input.name].length > 64) {
    fields.name = ['长度不能超过 64']
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields }

  return {
    ok: true,
    value: {
      username,
      usernameKey: normalizeUsername(username),
      password: input.password,
      name: input.name ?? null,
    },
  }
}

/** The email is an opaque Better Auth adapter detail and never derives from username. */
export function createInternalEmail(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  const localPart = randomUUID().replaceAll('-', '').toLowerCase()
  return `${localPart}@internal.syn.ie`
}
