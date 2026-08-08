import type { Registry } from '../meta/registry.ts'
import { attachmentResourceMeta, fileResourceMeta, storageResourceMeta } from './meta.ts'

export {
  attachmentResourceMeta,
  fileResourceMeta,
  storageResourceMeta,
  ATTACHMENT_RESOURCE_NAME,
  FILE_RESOURCE_NAME,
  STORAGE_RESOURCE_NAME,
} from './meta.ts'
export { SYS_STORAGE, type SysStoragePermission } from './permissions.ts'
export {
  buildOwnerRegistryFromMeta,
  createOwnerRegistry,
  type OwnerRegistry,
} from './owner-registry.ts'
export { createFileService, type FileService, type FileServiceDeps } from './service.ts'
export {
  createFileReconcileService,
  summarizeFileReconcile,
  type FileReconcileService,
  type FileReconcileDeps,
  type FileReconcileOptions,
  type FileReconcileReport,
  type StorageReconcileReport,
} from './reconcile.ts'
export { createStorageService, type StorageService, type StorageServiceDeps } from './storage-service.ts'
export { fileRoutes, storageRoutes } from './routes.ts'
export { createLocalStorage, createS3Storage, safeExtension, localPath } from './object-storage.ts'
export type { ObjectStorage, StoredObjectInfo } from './object-storage.ts'
export type * from './types.ts'

/** 将 files / attachments / storages Meta 注册进 Registry（启动期调用） */
export function registerFileResources(registry: Registry): void {
  registry.register(fileResourceMeta())
  registry.register(attachmentResourceMeta())
  registry.register(storageResourceMeta())
}
