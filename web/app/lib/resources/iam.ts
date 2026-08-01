import { unboundResourceClient, unavailableResourceOperation } from './unbound'

export const userClient = unboundResourceClient('sysUsers')
export const roleClient = unboundResourceClient('sysRoles')

export const createUser = unavailableResourceOperation
export const fetchUserAccess = unavailableResourceOperation
export const resetUserPassword = unavailableResourceOperation
export const fetchRolePermissions = unavailableResourceOperation
export const syncRolePermissions = unavailableResourceOperation
export const fetchPermissionCatalog = unavailableResourceOperation
