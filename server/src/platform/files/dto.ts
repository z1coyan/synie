import type { Attachment, StorageEndpoint, StorageKind, StoredFile } from './types.ts'

export function storedFileDto(value: StoredFile) {
  return {
    id: value.id,
    storage: value.storage,
    key: value.key,
    filename: value.filename,
    contentType: value.contentType,
    size: value.size,
    sha256: value.sha256,
    insertedAt: toIso(value.insertedAt),
    uploadedById: value.uploadedById,
  }
}

export function attachmentDto(value: Attachment) {
  return {
    id: value.id,
    fileId: value.fileId,
    ownerType: value.ownerType,
    ownerId: value.ownerId,
    category: value.category,
    companyId: value.companyId,
    insertedAt: toIso(value.insertedAt),
    file: value.file ? storedFileDto(value.file) : null,
  }
}

export function storageDto(value: StorageEndpoint) {
  return {
    id: value.id,
    name: value.name,
    label: value.label,
    kind: value.kind as StorageKind,
    root: value.root,
    endpoint: value.endpoint,
    region: value.region,
    bucket: value.bucket,
    prefix: value.prefix,
    accessKeyId: value.accessKeyId,
    secretConfigured: value.secretConfigured,
    builtin: value.builtin,
    isDefault: value.isDefault,
    insertedAt: toIso(value.insertedAt),
    updatedAt: toIso(value.updatedAt),
  }
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}
