export interface UploadedFile {
  id: string
  storage: string
  key: string
  filename: string
  contentType: string | null
  size: number
  sha256: string
  insertedAt: string
  uploadedById?: string | null
}

export interface UploadedAttachment {
  id: string
  fileId: string
  ownerType: string
  ownerId: string
  category: string
  companyId?: string | null
  insertedAt: string
}

export interface UploadResult {
  file: UploadedFile
  attachment?: UploadedAttachment | null
}

export interface FileAttachmentRecord extends UploadedAttachment {
  file: UploadedFile
}

export interface FileSemanticOperations {
  createUploadIntent(input: {
    filename: string; contentType: string; size: number; sha256: string
    ownerType?: string; ownerId?: string; category?: string
  }): Promise<{ id: string; expiresAt: number }>
  signUpload(intentId: string): Promise<{ finalized: boolean; url?: string; headers?: Record<string, string> }>
  finalizeUpload(intentId: string): Promise<UploadResult>
  downloadUrl(fileId: string): Promise<{ url: string; filename: string; contentType: string | null }>
  attach(fileId: string, input: { ownerType: string; ownerId: string; category?: string }): Promise<UploadedAttachment>
  listAttachments(input: { ownerType: string; ownerId: string; category?: string }): Promise<{ count: number; results: FileAttachmentRecord[] }>
  listFileAttachments(fileId: string): Promise<{ count: number; results: FileAttachmentRecord[] }>
  removeAttachment(id: string): Promise<void>
  removeFile(id: string): Promise<void>
  listFiles(input: { numItems: number; cursor: string | null }): Promise<unknown>
  getFile(id: string): Promise<unknown>
}

let operations: FileSemanticOperations | null = null

export function activateFileSemanticOperations(next: FileSemanticOperations): void {
  operations = next
}

function fileOperations(): FileSemanticOperations {
  if (!operations) throw new Error('产品文件能力尚未由 Convex 应用壳装配')
  return operations
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** Browser → signed S3 PUT → Convex HEAD/finalize. File bytes never cross a function body. */
export async function uploadFile(
  file: File,
  opts?: { ownerType?: string; ownerId?: string; category?: string },
): Promise<UploadResult> {
  const contentType = file.type || 'application/octet-stream'
  const intent = await fileOperations().createUploadIntent({
    filename: file.name,
    contentType,
    size: file.size,
    sha256: await sha256Hex(file),
    ...(opts?.ownerType ? { ownerType: opts.ownerType } : {}),
    ...(opts?.ownerId ? { ownerId: opts.ownerId } : {}),
    ...(opts?.category ? { category: opts.category } : {}),
  })
  const signed = await fileOperations().signUpload(intent.id)
  if (!signed.finalized) {
    if (!signed.url) throw new Error('上传地址生成失败')
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: file,
    })
    if (!response.ok) throw new Error(`对象存储上传失败:${response.status}`)
  }
  return fileOperations().finalizeUpload(intent.id)
}

const blobUrls = new WeakMap<Blob, string>()

export function blobUrl(blob: Blob): string {
  let url = blobUrls.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    blobUrls.set(blob, url)
  }
  return url
}

export async function fetchFileBlob(fileId: string): Promise<Blob> {
  const signed = await fileOperations().downloadUrl(fileId)
  const response = await fetch(signed.url)
  if (!response.ok) throw new Error(`文件下载失败:${response.status}`)
  return response.blob()
}

export async function downloadFile(fileId: string, filename: string): Promise<void> {
  const signed = await fileOperations().downloadUrl(fileId)
  const anchor = document.createElement('a')
  anchor.href = signed.url
  anchor.download = filename || signed.filename
  anchor.rel = 'noopener'
  anchor.click()
}

export async function attachFile(
  fileId: string,
  opts: { ownerType: string; ownerId: string; category?: string },
): Promise<UploadedAttachment> {
  return fileOperations().attach(fileId, opts)
}

export async function queryFileAttachments(input: {
  ownerType: string; ownerId: string; category?: string
}) {
  return fileOperations().listAttachments(input)
}

export async function queryAttachmentsForFile(fileId: string) {
  return fileOperations().listFileAttachments(fileId)
}

export async function removeFileAttachment(id: string): Promise<void> {
  await fileOperations().removeAttachment(id)
}

export async function removeProductFile(id: string): Promise<void> {
  await fileOperations().removeFile(id)
}

export function listProductFiles(input: { numItems: number; cursor: string | null }) {
  return fileOperations().listFiles(input)
}

export function getProductFile(id: string) {
  return fileOperations().getFile(id)
}
