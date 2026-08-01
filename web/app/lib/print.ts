export interface PrintTemplateOption {
  id: string
  name: string
  resource: string
  isDefault: boolean
  remarks: string | null
}

export interface FieldCatalogEntry { name: string; label: string }
export interface FieldCatalogLoop { name: string; label: string; fields: FieldCatalogEntry[] }
export interface FieldCatalog { resource: string; fields: FieldCatalogEntry[]; loops: FieldCatalogLoop[] }

export interface PrintJobSummary {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'retryable' | 'failed' | 'expired'
  attempts: number
  errorCode: string | null
  filename: string
}

export interface PrintingSemanticOperations {
  listResources(): Promise<{ resources: string[] }>
  listTemplates(resource: string): Promise<PrintTemplateOption[]>
  fieldCatalog(resource: string): Promise<FieldCatalog>
  exportXlsx(input: { resource: string; ids: string[]; templateId: string; requestNonce: string }): Promise<{ url: string; filename: string }>
  startPrint(input: { resource: string; ids: string[]; templateId: string; requestNonce: string }): Promise<PrintJobSummary>
  resultUrl(jobId: string): Promise<{ url: string; filename: string }>
}

let operations: PrintingSemanticOperations | null = null

export function activatePrintingSemanticOperations(next: PrintingSemanticOperations): void {
  operations = next
}

function printing(): PrintingSemanticOperations {
  if (!operations) throw new Error('打印能力尚未由 Convex 应用壳装配')
  return operations
}

export function listPrintResources() {
  return printing().listResources()
}

export function fetchPrintTemplates(resource: string): Promise<PrintTemplateOption[]> {
  return printing().listTemplates(resource)
}

export function fetchFieldCatalog(resource: string): Promise<FieldCatalog> {
  return printing().fieldCatalog(resource)
}

export function exportTemplateXlsx(input: {
  resource: string; ids: string[]; templateId: string; requestNonce: string
}) {
  return printing().exportXlsx(input)
}

export function startTemplatePrint(input: {
  resource: string; ids: string[]; templateId: string; requestNonce: string
}) {
  return printing().startPrint(input)
}

export function fetchPrintResultUrl(jobId: string) {
  return printing().resultUrl(jobId)
}

export function downloadSignedUrl(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()
}

export function openPdfUrl(url: string): boolean {
  const win = window.open(url, '_blank', 'noopener')
  return Boolean(win)
}

export function printErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'worker_unavailable': return 'PDF 转换服务暂不可用，请改用导出 Excel 或稍后重试'
    case 'busy': return 'PDF 转换服务繁忙，请稍后重试'
    case 'timeout': return 'PDF 转换超时，请减少批量条数或稍后重试'
    case 'input_mismatch': return '打印模板文件校验失败，请联系管理员'
    case 'output_failed': return 'PDF 结果保存失败，请稍后重试'
    case 'convert_failed': return 'PDF 转换失败，请检查模板版式'
    case 'input_expired': return '打印任务已过期，请重新发起'
    default: return 'PDF 生成失败，请稍后重试'
  }
}
