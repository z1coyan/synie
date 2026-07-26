import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type UserCreate = components['schemas']['SystemUserCreate']
type UserUpdate = components['schemas']['SystemUserUpdate']
type RoleCreate = components['schemas']['SystemRoleCreate']
type RoleUpdate = components['schemas']['SystemRoleUpdate']

function listBody(input: ResourceQuery): components['schemas']['ListQuery'] {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('IAM REST 资源不支持 GraphQL fixedFilter、额外字段或 joinFields')
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: input.filter as components['schemas']['FilterState'],
  }
}

export const userClient: ResourceClient = {
  id: 'rest:sysUsers',
  async meta() {
    return gridMeta(await apiData(apiClient.GET('/meta/resources/{name}', { params: { path: { name: 'sysUsers' } } })))
  },
  async query(input) {
    const result = await apiData(apiClient.POST('/system/users/query', { body: listBody(input) }))
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return await apiData(apiClient.GET('/system/users/{id}', { params: { path: { id } } })) as Row
  },
  async create(values) {
    const result = await createUser(values as UserCreate)
    return result.user as Row
  },
  async update(id, values) {
    return await apiData(apiClient.PATCH('/system/users/{id}', {
      params: { path: { id } }, body: values as UserUpdate,
    })) as Row
  },
  async delete(id) {
    await apiData(apiClient.DELETE('/system/users/{id}', { params: { path: { id } } }))
  },
}

export const roleClient: ResourceClient = {
  id: 'rest:sysRoles',
  async meta() {
    return gridMeta(await apiData(apiClient.GET('/meta/resources/{name}', { params: { path: { name: 'sysRoles' } } })))
  },
  async query(input) {
    const result = await apiData(apiClient.POST('/system/roles/query', { body: listBody(input) }))
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return await apiData(apiClient.GET('/system/roles/{id}', { params: { path: { id } } })) as Row
  },
  async create(values) {
    return await apiData(apiClient.POST('/system/roles', { body: values as RoleCreate })) as Row
  },
  async update(id, values) {
    return await apiData(apiClient.PATCH('/system/roles/{id}', {
      params: { path: { id } }, body: values as RoleUpdate,
    })) as Row
  },
  async delete(id) {
    await apiData(apiClient.DELETE('/system/roles/{id}', { params: { path: { id } } }))
  },
}

export const createUser = (body: UserCreate) => apiData(apiClient.POST('/system/users', { body }))
export const fetchUserAccess = (id: string) => apiData(apiClient.GET('/system/users/{id}/access', { params: { path: { id } } }))
export const resetUserPassword = (id: string) => apiData(apiClient.POST('/system/users/{id}/password', { params: { path: { id } } }))
export const fetchRolePermissions = (id: string) => apiData(apiClient.GET('/system/roles/{id}/permissions', { params: { path: { id } } }))
export const syncRolePermissions = (id: string, permissions: string[]) => apiData(apiClient.PUT('/system/roles/{id}/permissions', {
  params: { path: { id } }, body: { permissions },
}))
export const fetchPermissionCatalog = () => apiData(apiClient.GET('/meta/permission-catalog'))
