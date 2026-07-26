import { apiClient, apiData } from './client'
import type { components } from './schema'

export type SessionUser = components['schemas']['SessionUser']
export type MeResponse = components['schemas']['MeResponse']

export const login = (username: string, password: string) =>
  apiData(apiClient.POST('/auth/login', { body: { username, password } }))

export const fetchMe = () => apiData(apiClient.GET('/auth/me'))
