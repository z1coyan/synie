import { normalizeUsername, validateUsername } from '../lib/username'

export type ManagedUserInput = {
  username: string
  name?: string | null
}

export type PreparedManagedUser = {
  username: string
  usernameKey: string
  name: string | null
}

export type ManagedUserValidation =
  | { ok: true; value: PreparedManagedUser }
  | { ok: false; fields: Record<string, string[]> }

export function prepareManagedUser(input: ManagedUserInput): ManagedUserValidation {
  const username = input.username.trim()
  const fields: Record<string, string[]> = {}
  const usernameError = validateUsername(input.username)
  let name = input.name == null ? null : input.name.trim()

  if (usernameError) fields.username = [usernameError]
  if (name === '') name = null
  if (name != null && [...name].length > 64) fields.name = ['长度不能超过 64']

  if (Object.keys(fields).length > 0) return { ok: false, fields }
  return {
    ok: true,
    value: {
      username,
      usernameKey: normalizeUsername(username),
      name,
    },
  }
}

/** Generate the one-time password returned exactly once by user management. */
export function createOneTimePassword(
  randomBytes: (target: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (target) =>
    crypto.getRandomValues(target),
): string {
  const bytes = randomBytes(new Uint8Array(12))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function normalizeCompanyIds(values: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const value of values) {
    const id = value.trim()
    if (id) normalized.add(id)
  }
  return [...normalized].sort()
}
