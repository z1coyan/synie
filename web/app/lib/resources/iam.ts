import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { strictResourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

type UserCreate = Record<string, unknown>
type UserUpdate = Record<string, unknown>
type RoleCreate = Record<string, unknown>
type RoleUpdate = Record<string, unknown>

export const userClient: ResourceClient = {
  id: 'rest:sysUsers',
  async query(input) {
    const result = await apiData(api.system.users.query.$post({
      json: strictResourceListBody(input, 'IAM'),
    }))
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
  async query(input) {
    const result = await apiData(api.system.roles.query.$post({
      json: strictResourceListBody(input, 'IAM'),
    }))
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
  apiData(api.system.users.$post({ json: body as never }))
export const fetchUserAccess = (id: string) =>
  apiData(api.system.users[':id'].access.$get({ param: { id } }))
export const resetUserPassword = (id: string) =>
  apiData(
    api.system.users[':id']['reset-password'].$post({ param: { id } }),
  )
export const fetchRolePermissions = (id: string) =>
  apiData(
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
  apiData(
    api.meta['permission-catalog'].$get(),
  )
