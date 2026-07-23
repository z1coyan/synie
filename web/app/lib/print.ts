import { getToken } from './auth'

export interface PrintTemplateOption {
  id: string
  name: string
  resource: string
  isDefault: boolean
  remarks: string | null
}

export interface FieldCatalogEntry {
  name: string
  label: string
}

export interface FieldCatalogLoop {
  name: string
  label: string
  fields: FieldCatalogEntry[]
}

export interface FieldCatalog {
  resource: string
  fields: FieldCatalogEntry[]
  loops: FieldCatalogLoop[]
}

function authHeaders(json = false): Record<string, string> {
  const token = getToken()
  const h: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 401) return '未登录或登录已过期'
  if (res.status === 403) return '无权限执行该操作'
  try {
    const json = (await res.json()) as { error?: string }
    if (json.error) return json.error
  } catch {
    // ignore
  }
  return `请求失败: ${res.status}`
}

export async function fetchPrintTemplates(resource: string): Promise<PrintTemplateOption[]> {
  const res = await fetch(`/api/print/templates?resource=${encodeURIComponent(resource)}`, {
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  const data = (await res.json()) as { templates: PrintTemplateOption[] }
  return data.templates
}

export async function fetchFieldCatalog(resource: string): Promise<FieldCatalog> {
  const res = await fetch(`/api/print/field-catalog?resource=${encodeURIComponent(resource)}`, {
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return (await res.json()) as FieldCatalog
}

/** 调用后端打印/导出；返回 blob 与文件名。 */
export async function runTemplateOutput(opts: {
  resource: string
  ids: string[]
  templateId: string
  mode: 'print' | 'export'
}): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch('/api/print', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      resource: opts.resource,
      ids: opts.ids,
      template_id: opts.templateId,
      mode: opts.mode,
    }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))

  const cd = res.headers.get('content-disposition') || ''
  const m = /filename="([^"]+)"/.exec(cd)
  const filename = m ? decodeURIComponent(m[1]) : opts.mode === 'print' ? 'print.pdf' : 'export.xlsx'
  const blob = await res.blob()
  return { blob, filename }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 打开 PDF blob（弹窗拦截时返回 false）。 */
export function openPdfBlob(blob: Blob): boolean {
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    URL.revokeObjectURL(url)
    return false
  }
  // 延迟 revoke 给浏览器加载时间
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}
