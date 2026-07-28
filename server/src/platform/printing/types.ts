import type { ListQuery } from '@synie/shared'

/** 打印模板主数据（wire camelCase） */
export interface Template {
  id: string
  name: string
  resource: string
  isDefault: boolean
  remarks: string | null
  fileId: string
  insertedAt: Date
  updatedAt: Date
}

export interface CreateInput {
  name: string
  resource: string
  fileId: string
  remarks?: string | null
}

export interface UpdateInput {
  name?: string
  fileId?: string
  /** 三态：undefined=不改；null=清空；string=设值 */
  remarks?: string | null | undefined
  remarksPresent?: boolean
}

export type TemplateListQuery = ListQuery

export interface TemplateList {
  count: number
  results: Template[]
}

export interface PrintField {
  name: string
  label: string
}

export interface PrintLoop {
  name: string
  label: string
  fields: PrintField[]
  nestedLoops?: string[]
}

export interface ResourceCatalog {
  resource: string
  fields: PrintField[]
  loops: PrintLoop[]
}

export interface PlaceholderSet {
  fields: string[]
  nested: Record<string, string[]>
}

/** 单份单据填充数据：值一律字符串，空值归空串 */
export interface PrintDoc {
  fields: Record<string, string>
  loops: Record<string, Array<Record<string, string>>>
}

export interface NamedDoc {
  name: string
  doc: PrintDoc
}

export interface BuiltDoc {
  sheetName: string
  doc: PrintDoc
}

export const RENDER_MODE_PRINT = 'print'
export const RENDER_MODE_EXPORT = 'export'
export const MAX_RENDER_BATCH = 100

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const PDF_CONTENT_TYPE = 'application/pdf'

export interface RenderInput {
  resource: string
  mode: typeof RENDER_MODE_PRINT | typeof RENDER_MODE_EXPORT | string
  templateId: string
  ids: string[]
}

export interface RenderOutput {
  binary: Uint8Array
  contentType: string
  filename: string
}

/** 跨模块读已存文件（files 服务实现） */
export interface StoredFileReader {
  readStoredFile(id: string): Promise<{ file: { filename: string }; content: Uint8Array }>
}
