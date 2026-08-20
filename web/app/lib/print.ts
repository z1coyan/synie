import type { ApiErrorBody } from '@synie/shared'
import { APIError, api, apiData } from './api/client'
import { AppError } from './errors'

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
    api.printing.templates.$get({ query: { resource } }),
  )
  return data.results
}

export async function fetchFieldCatalog(resource: string): Promise<FieldCatalog> {
  return apiData(
    api.printing['field-catalog'].$get({ query: { resource } }),
  )
}

/** 调用后端打印/导出（契约端点 POST /printing/render）；返回 blob 与文件名。 */
export async function runTemplateOutput(opts: {
  resource: string
  ids?: string[]
  context?: Record<string, unknown>
  templateId: string
  mode: 'print' | 'export'
}): Promise<{ blob: Blob; filename: string }> {
  const response = await api.printing.render.$post({
    json: {
      resource: opts.resource,
      templateId: opts.templateId,
      mode: opts.mode,
      ...(opts.context ? { context: opts.context } : { ids: opts.ids ?? [] }),
    },
  })
  if (!response.ok) {
    let envelope: ApiErrorBody | undefined
    try {
      envelope = (await response.json()) as ApiErrorBody
    } catch {
      // 非 JSON
    }
    if (envelope?.error) throw new APIError(envelope.error, response.status)
    throw new AppError(`打印/导出失败: ${response.status}`, ['http_error'])
  }

  const cd = response.headers.get('content-disposition') || ''
  const m = /filename="([^"]+)"/.exec(cd)
  const filename = m
    ? decodeURIComponent(m[1]!)
    : opts.mode === 'print'
      ? 'print.pdf'
      : 'export.xlsx'
  const blob = await response.blob()
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
