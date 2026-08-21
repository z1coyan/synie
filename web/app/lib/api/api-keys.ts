import { api, apiData } from './client'

export interface UserApiKey {
  id: string
  name: string
  tokenHint: string
  expiresAt: string | null
  lastUsedAt: string | null
  insertedAt: string
}

export interface CreatedUserApiKey extends UserApiKey {
  token: string
}

export const listApiKeys = () =>
  apiData(api.auth['api-keys'].$get()) as Promise<{ results: UserApiKey[] }>

export const createApiKey = (body: { name: string; expiresAt?: string | null }) =>
  apiData(api.auth['api-keys'].$post({ json: body })) as Promise<CreatedUserApiKey>

export const revokeApiKey = (id: string) =>
  apiData(api.auth['api-keys'][':id'].$delete({ param: { id } }))
