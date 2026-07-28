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

/** 三态补丁：undefined=未传，null=清空，string=设值 */
export interface StorageUpdateInput {
  label?: string
  root?: string | null
  endpoint?: string | null
  region?: string | null
  bucket?: string | null
  prefix?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string
  /** 哪些可选字段出现在请求体中（含显式 null） */
  present: {
    label?: boolean
    root?: boolean
    endpoint?: boolean
    region?: boolean
    bucket?: boolean
    prefix?: boolean
    accessKeyId?: boolean
    secretAccessKey?: boolean
  }
}

export interface StorageList {
  count: number
  results: StorageEndpoint[]
}

export interface OwnerSpec {
  table: string
  permissionPrefix: string
  companyScoped?: boolean
}
