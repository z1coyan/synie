import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { restTransport } from './rest-transport'
import type { ResourceClient } from './types'

const userTransport = restTransport('sysUsers', api.system.users, {
  strictListLabel: 'IAM',
})

export const userClient: ResourceClient = {
  ...userTransport,
  // 偏离标准形状：创建响应为 { user } 包装，须解包后再交给调用方。
  async create(input) {
    const result = await createUser(input as never)
    return result.user as Row
  },
}

export const roleClient = restTransport('sysRoles', api.system.roles, {
  strictListLabel: 'IAM',
})

export const createUser = (body: Record<string, unknown>) =>
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
