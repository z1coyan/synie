import { getToken } from './auth'

/** 文件 REST 端点(multipart/二进制不走 GraphQL,见后端 SynieWeb.FileController) */

export interface UploadedFile {
  id: string
  filename: string
  contentType: string | null
  size: number | null
  sha256: string | null
  insertedAt: string
}

export interface UploadedAttachment {
  id: string
  fileId: string
  ownerType: string
  ownerId: string
  category: string
}

export interface UploadResult {
  file: UploadedFile
  attachment: UploadedAttachment | null
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 403) return '无权限访问,请联系管理员分配权限'
  try {
    const json = (await res.json()) as { error?: string }
    if (json.error) return json.error
  } catch {
    // 非 JSON 响应,落到通用信息
  }
  return `请求失败:${res.status} ${res.statusText}`
}

/** 上传文件;带 owner 参数时同请求创建附件关联 */
export async function uploadFile(
  file: File,
  opts?: { ownerType?: string; ownerId?: string; category?: string }
): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file)
  if (opts?.ownerType) form.append('owner_type', opts.ownerType)
  if (opts?.ownerId) form.append('owner_id', opts.ownerId)
  if (opts?.category) form.append('category', opts.category)

  const res = await fetch('/api/files', { method: 'POST', headers: authHeaders(), body: form })
  if (!res.ok) throw new Error(await errorMessage(res))
  return (await res.json()) as UploadResult
}

// Blob → objectURL 一对一缓存,不主动 revoke:卸载即 revoke 会与浮层退场动画期间
// 仍引用该 URL 的 <img> 竞态(console 刷 ERR_FILE_NOT_FOUND);URL 随 Blob 被 GC 一起释放,
// 预览量级的驻留可接受,重挂复用同一 URL 也免了图片闪烁
const blobUrls = new WeakMap<Blob, string>()

/** Blob 的稳定 objectURL(带缓存),配合 fetchFileBlob 做 <img> 内联展示 */
export function blobUrl(blob: Blob): string {
  let url = blobUrls.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    blobUrls.set(blob, url)
  }
  return url
}

/** 取文件字节为 Blob(经 fetch 带鉴权头),图片预览等内联展示用 */
export async function fetchFileBlob(fileId: string): Promise<Blob> {
  const res = await fetch(`/api/files/${fileId}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.blob()
}

/** 下载文件并触发浏览器保存(经 fetch 带鉴权头,后端本地回源或 302 预签名) */
export async function downloadFile(fileId: string, filename: string): Promise<void> {
  const res = await fetch(`/api/files/${fileId}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await errorMessage(res))

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 给已上传的裸文件补挂宿主附件(OCR 动线:识别先上传、单据保存成功后挂接) */
export async function attachFile(
  fileId: string,
  opts: { ownerType: string; ownerId: string; category?: string }
): Promise<UploadedAttachment> {
  const form = new FormData()
  form.append('owner_type', opts.ownerType)
  form.append('owner_id', opts.ownerId)
  if (opts.category) form.append('category', opts.category)

  const res = await fetch(`/api/files/${fileId}/attachments`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  const json = (await res.json()) as { attachment: UploadedAttachment }
  return json.attachment
}
