import type { ListQuery } from '@synie/shared'

export interface StoredFile {
  id: string
  storage: string
  key: string
  filename: string
  contentType: string | null
  size: number
  sha256: string
  insertedAt: Date
  uploadedById: string | null
}

export interface Attachment {
  id: string
  fileId: string
  ownerType: string
  ownerId: string
  category: string
  companyId: string | null
  insertedAt: Date
  file?: StoredFile | null
}

export interface UploadInput {
  data: Uint8Array
  filename: string
  contentType: string
  ownerType?: string
  ownerId?: string
  category?: string
}

export interface UploadResult {
  file: StoredFile
  attachment?: Attachment
}

export interface AttachInput {
  ownerType: string
  ownerId: string
  category?: string
}

export interface DownloadResult {
  filename: string
  contentType: string
  content?: Uint8Array
  redirectUrl?: string
}

export interface FileListQuery extends Partial<ListQuery> {
  limit?: number
  offset?: number
}

export interface FileList {
  count: number
  results: StoredFile[]
}

export interface AttachmentQuery {
  limit?: number
  offset?: number
  fileId?: string
  ownerType?: string
  ownerId?: string
  category?: string
}

export interface AttachmentList {
  count: number
  results: Attachment[]
}

export type StorageKind = 'LOCAL' | 'S3' | 'OSS'

export interface StorageEndpoint {
  id: string
  name: string
  label: string
  kind: StorageKind
  root: string | null
  endpoint: string | null
  region: string | null
  bucket: string | null
  prefix: string | null
  accessKeyId: string | null
  secretConfigured: boolean
  builtin: boolean
  isDefault: boolean
  insertedAt: Date
  updatedAt: Date
}

export interface StorageCreateInput {
  name: string
  label: string
  kind: string
  root?: string | null
  endpoint?: string | null
  region?: string | null
  bucket?: string | null
  prefix?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string | null
}

/** 三态补丁：undefined=未传，null=清空，string=设值（present-key 语义由内核承接） */
export interface StorageUpdateInput {
  label?: string
  root?: string | null
  endpoint?: string | null
  region?: string | null
  bucket?: string | null
  prefix?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string
}

export interface StorageList {
  count: number
  results: StorageEndpoint[]
}

/**
 * 附件宿主：多态宿主可达性判定的解析入口。
 * `resource` 是 sealed registry 键——码级与行级判定全部取宿主自己的 authz 声明，
 * 故此处不再声明权限前缀与公司域（避免与 meta 出现第二份事实）。
 */
export interface OwnerSpec {
  resource: string
  table: string
}
