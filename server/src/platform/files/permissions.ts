/**
 * 存储接入权限常量：ResourceDefinition 与 service 鉴权共用，禁止字符串漂移。
 */
export const SYS_STORAGE = {
  prefix: 'sys.storage',
  read: 'sys.storage:read',
  create: 'sys.storage:create',
  update: 'sys.storage:update',
  delete: 'sys.storage:delete',
} as const

export type SysStoragePermission = (typeof SYS_STORAGE)[keyof typeof SYS_STORAGE]
