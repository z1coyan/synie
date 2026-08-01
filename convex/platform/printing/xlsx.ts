/**
 * xlsx 占位符抽取（只读首个 sheet + sharedStrings）。
 * 对齐 server-go platform/printing/xlsx.go。
 */
import type { PlaceholderSet } from './types.ts'
import { bytesToText, cleanPartName, unzipParts } from './zip.ts'

const PLACEHOLDER_PATTERN = /\$\{([^{}]+)\}/g

export function invalidTemplate(message: string): Error {
  return new Error(`无法解析模板: ${message}`)
}

export function extractPlaceholders(value: Uint8Array): PlaceholderSet {
  let parts
  try {
    parts = unzipParts(value)
  } catch {
    throw invalidTemplate('不是有效的 xlsx（zip）文件')
  }
  const workbook = parts.get('xl/workbook.xml')
  if (!workbook) throw invalidTemplate('缺少 xl/workbook.xml')
  const relationshipsRaw = parts.get('xl/_rels/workbook.xml.rels')
  if (!relationshipsRaw) throw invalidTemplate('缺少 xl/_rels/workbook.xml.rels')

  const relationId = firstSheetRelation(bytesToText(workbook))
  const target = findRelationshipTarget(bytesToText(relationshipsRaw), relationId)
  if (!target) throw invalidTemplate('找不到首个工作表')

  const sheetPath = cleanPartName(`xl/${target.replace(/^\/+/, '')}`)
  const sheet = parts.get(sheetPath)
  if (!sheet) throw invalidTemplate('缺少首个工作表')

  const shared = parseSharedStrings(parts.get('xl/sharedStrings.xml'))
  const texts = parseWorksheetTexts(bytesToText(sheet), shared)
  return placeholdersFromTexts(texts)
}

function firstSheetRelation(workbook: string): string {
  const match = /<sheet\b([^>]*)\/?>/.exec(workbook)
  if (!match) throw invalidTemplate('工作簿没有工作表')
  const attrs = match[1] ?? ''
  const idMatch = /\br:id="([^"]+)"/.exec(attrs) ?? /\bid="([^"]+)"/.exec(attrs)
  if (!idMatch?.[1]) throw invalidTemplate('首个工作表缺少关系')
  return idMatch[1]
}

function findRelationshipTarget(rels: string, id: string): string {
  const pattern = /<Relationship\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(rels)) !== null) {
    const attrs = m[1] ?? ''
    const rid = /\bId="([^"]+)"/.exec(attrs)?.[1]
    if (rid !== id) continue
    return /\bTarget="([^"]+)"/.exec(attrs)?.[1] ?? ''
  }
  return ''
}

/** 解析 sharedStrings：合并每个 <si> 内全部 <t> 文本 */
export function parseSharedStrings(value: Uint8Array | undefined): string[] {
  if (!value || value.length === 0) return []
  const xml = bytesToText(value)
  const result: string[] = []
  const siPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let siMatch: RegExpExecArray | null
  while ((siMatch = siPattern.exec(xml)) !== null) {
    const body = siMatch[1] ?? ''
    let text = ''
    const tPattern = /<t\b[^>]*>([^<]*)<\/t>/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tPattern.exec(body)) !== null) {
      text += tMatch[1] ?? ''
    }
    result.push(text)
  }
  return result
}

function parseWorksheetTexts(sheet: string, shared: string[]): string[] {
  const result: string[] = []
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let m: RegExpExecArray | null
  while ((m = cellPattern.exec(sheet)) !== null) {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? ''
    if (type === 's') {
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1]
      const index = v !== undefined ? Number.parseInt(v, 10) : NaN
      if (!Number.isNaN(index) && index >= 0 && index < shared.length) {
        result.push(shared[index]!)
      }
      continue
    }
    const texts: string[] = []
    const tPattern = /<t\b[^>]*>([^<]*)<\/t>/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tPattern.exec(body)) !== null) {
      texts.push(tMatch[1] ?? '')
    }
    if (texts.length > 0) {
      result.push(texts.join(''))
    } else {
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1]
      if (v) result.push(v)
    }
  }
  return result
}

export function placeholdersFromTexts(texts: string[]): PlaceholderSet {
  const fields: string[] = []
  const nested: Record<string, string[]> = {}
  for (const text of texts) {
    PLACEHOLDER_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
      const name = (match[1] ?? '').trim()
      if (!name) continue
      const index = name.indexOf('.')
      if (index < 0) {
        fields.push(name)
        continue
      }
      const prefix = name.slice(0, index)
      const suffix = name.slice(index + 1)
      nested[prefix] = nested[prefix] ?? []
      nested[prefix]!.push(suffix)
    }
  }
  return {
    fields: uniqueSorted(fields),
    nested: Object.fromEntries(
      Object.entries(nested).map(([k, v]) => [k, uniqueSorted(v)]),
    ),
  }
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export { PLACEHOLDER_PATTERN }
