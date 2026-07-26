import { getToken } from './auth'

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

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 403) return '无权限访问,请联系管理员分配权限'
  try {
    const json = (await res.json()) as {
      error?: string | { message?: string }
      message?: string
    }
    if (typeof json.error === 'string') return json.error
    if (json.error?.message) return json.error.message
    if (json.message) return json.message
  } catch {
    // 二进制或非 JSON 错误响应落到通用信息。
  }
  return `请求失败:${res.status} ${res.statusText}`
}

/** multipart 上传；可选在同一事务挂接宿主。 */
export async function uploadFile(
  file: File,
  opts?: { ownerType?: string; ownerId?: string; category?: string }
): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file)
  if (opts?.ownerType) form.append('ownerType', opts.ownerType)
  if (opts?.ownerId) form.append('ownerId', opts.ownerId)
  if (opts?.category) form.append('category', opts.category)

  const res = await fetch('/api/v1/files', {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return (await res.json()) as UploadResult
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
  const res = await fetch(`/api/v1/files/${fileId}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.blob()
}

export async function downloadFile(fileId: string, filename: string): Promise<void> {
  const res = await fetch(`/api/v1/files/${fileId}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await errorMessage(res))

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** OCR 等先上传后保存单据的流程，用 JSON 命令补挂已上传文件。 */
export async function attachFile(
  fileId: string,
  opts: { ownerType: string; ownerId: string; category?: string }
): Promise<UploadedAttachment> {
  const res = await fetch(`/api/v1/files/${fileId}/attachments`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  const json = (await res.json()) as { attachment: UploadedAttachment }
  return json.attachment
}
