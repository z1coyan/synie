import { apiData, api } from '../api/client'
import type { DataScope } from '@synie/shared'
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

/**
 * 部门：公司域组织树（后端走 guard + Permit，前端与其他公司域资源无异）。
 * 不走 strictListLabel——树页要用 fixedFilter 按公司收窄，严格模式会 fail-closed 拒掉。
 */
export const departmentClient = restTransport('sysDepartments', api.system.departments)

export const createUser = (body: Record<string, unknown>) =>
  apiData(api.system.users.$post({ json: body as never }))
export const fetchUserAccess = (id: string) =>
  apiData(api.system.users[':id'].access.$get({ param: { id } }))
export const resetUserPassword = (id: string) =>
  apiData(
    api.system.users[':id']['reset-password'].$post({ param: { id } }),
  )
/** (role, code, scope) 三元组授权（spec §3）；scope 为 DataScope 名 */
export interface RolePermissionGrant {
  permission: string
  scope: DataScope
}

export const fetchRolePermissions = (id: string) =>
  apiData(
    api.system.roles[':id'].permissions.$get({ param: { id } }),
  )
export const syncRolePermissions = (id: string, permissions: RolePermissionGrant[]) =>
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
export const fetchRoleMenus = (id: string) =>
  apiData(api.system.roles[':id'].menus.$get({ param: { id } }))
export const syncRoleMenus = (id: string, menuCodes: string[]) =>
  apiData(
    api.system.roles[':id'].menus.$put({
      param: { id },
      json: { menuCodes },
    }),
  )
