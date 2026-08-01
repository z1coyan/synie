export interface PrintField { name: string; label: string }
export interface PrintLoop { name: string; label: string; fields: PrintField[]; nestedLoops?: string[] }
export interface PrintResourceCatalog { resource: string; fields: PrintField[]; loops: PrintLoop[] }
export interface PlaceholderSet { fields: string[]; nested: Record<string, string[]> }
export interface PrintDoc { fields: Record<string, string>; loops: Record<string, Array<Record<string, string>>> }
export interface NamedDoc { name: string; doc: PrintDoc }
export interface BuiltDoc { sheetName: string; doc: PrintDoc }

export const MAX_RENDER_BATCH = 100
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const PDF_CONTENT_TYPE = 'application/pdf'
