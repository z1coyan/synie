import { APIError, apiClient, apiData } from './api/client'
import { AppError } from './errors'
import type { components } from './api/schema'

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

export async function fetchPrintTemplates(resource: string): Promise<PrintTemplateOption[]> {
  const data = await apiData(
    apiClient.GET('/printing/templates', { params: { query: { resource } } }),
  )
  return data.results as PrintTemplateOption[]
}

export async function fetchFieldCatalog(resource: string): Promise<FieldCatalog> {
  return (await apiData(
    apiClient.GET('/printing/field-catalog', { params: { query: { resource } } }),
  )) as components['schemas']['PrintFieldCatalog']
}

/** 调用后端打印/导出（契约端点 POST /printing/render）；返回 blob 与文件名。 */
export async function runTemplateOutput(opts: {
  resource: string
  ids: string[]
  templateId: string
  mode: 'print' | 'export'
}): Promise<{ blob: Blob; filename: string }> {
  const result = await apiClient.POST('/printing/render', {
    body: {
      resource: opts.resource,
      ids: opts.ids,
      templateId: opts.templateId,
      mode: opts.mode,
    },
    parseAs: 'blob',
  })
  if (!result.response.ok) {
    const envelope = result.error as components['schemas']['ErrorEnvelope'] | undefined
    if (envelope?.error) throw new APIError(envelope.error, result.response.status)
    throw new AppError(`打印/导出失败: ${result.response.status}`, ['http_error'])
  }

  const cd = result.response.headers.get('content-disposition') || ''
  const m = /filename="([^"]+)"/.exec(cd)
  const filename = m ? decodeURIComponent(m[1]) : opts.mode === 'print' ? 'print.pdf' : 'export.xlsx'
  return { blob: result.data as unknown as Blob, filename }
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
