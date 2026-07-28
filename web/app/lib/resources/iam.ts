import type { ListQuery } from '@synie/shared'
import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type UserCreate = Record<string, unknown>
type UserUpdate = Record<string, unknown>
type RoleCreate = Record<string, unknown>
type RoleUpdate = Record<string, unknown>

function listBody(input: ResourceQuery): ListQuery {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('IAM REST 资源不支持 GraphQL fixedFilter、额外字段或 joinFields')
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: input.filter as FilterState,
  }
}

export const userClient: ResourceClient = {
  id: 'rest:sysUsers',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({ param: { name: 'sysUsers' } })))
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(api.system.users.query.$post({ json: listBody(input) }))
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return await apiData(api.system.users[':id'].$get({ param: { id } })) as Row
  },
  async create(values) {
    const result = await createUser(values as never)
    return result.user as Row
  },
  async update(id, values) {
    return await apiData(api.system.users[':id'].$patch({
      param: { id }, json: values as never})) as never
  },
  async delete(id) {
    await apiData(api.system.users[':id'].$delete({ param: { id } }))
  },
}

export const roleClient: ResourceClient = {
  id: 'rest:sysRoles',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({ param: { name: 'sysRoles' } })))
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(api.system.roles.query.$post({ json: listBody(input) }))
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return await apiData(api.system.roles[':id'].$get({ param: { id } })) as Row
  },
  async create(values) {
    return await apiData(api.system.roles.$post({ json: values as never })) as never
  },
  async update(id, values) {
    return await apiData(api.system.roles[':id'].$patch({
      param: { id }, json: values as never})) as never
  },
  async delete(id) {
    await apiData(api.system.roles[':id'].$delete({ param: { id } }))
  },
}

export const createUser = (body: UserCreate) =>
  apiData<{ user: Row; password?: string }>(api.system.users.$post({ json: body as never }))
export const fetchUserAccess = (id: string) =>
  apiData<{
    roles: Array<{ id: string; name: string }>
    companies: Array<{ id: string; name: string }>
  }>(api.system.users[':id'].access.$get({ param: { id } }))
export const resetUserPassword = (id: string) =>
  apiData<{ password: string }>(
    api.system.users[':id']['reset-password'].$post({ param: { id } }),
  )
export const fetchRolePermissions = (id: string) =>
  apiData<{ rows: Array<Record<string, unknown>> }>(
    api.system.roles[':id'].permissions.$get({ param: { id } }),
  )
export const syncRolePermissions = (id: string, permissions: string[]) =>
  apiData(
    api.system.roles[':id'].permissions.$put({
      param: { id },
      json: { permissions },
    }),
  )
export const fetchPermissionCatalog = () =>
  apiData<{ groups: Array<{ prefix: string; label: string; actions: string[] }> }>(
    api.meta['permission-catalog'].$get(),
  )
