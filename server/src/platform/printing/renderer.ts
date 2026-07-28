/**
 * xlsx 模板填充引擎（打印/导出共用）。
 * 对齐 server-go platform/printing/renderer.go：最小侵入 zip+XML，禁止 exceljs。
 */
import type { NamedDoc, PrintDoc } from './types.ts'
import { invalidTemplate, parseSharedStrings, PLACEHOLDER_PATTERN } from './xlsx.ts'
import {
  bytesToText,
  cleanPartName,
  setPartText,
  textToBytes,
  unzipParts,
  zipParts,
  type ZipParts,
} from './zip.ts'

export const ERR_EMPTY_DOCS = new Error('empty docs')

const ROW_PATTERN = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g
const CELL_PATTERN = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g
const MERGE_PATTERN = /<mergeCells\b[^>]*?(?:\/>|>[\s\S]*?<\/mergeCells>)/g
const BRKS_PATTERN = /<rowBreaks\b[^>]*?(?:\/>|>[\s\S]*?<\/rowBreaks>)/g
const REF_PATTERN = /(^|[^A-Za-z0-9])(\$?)([A-Za-z]{0,3})(\$?)(\d+)/g

const REL_TAG_PATTERN = /<Relationship\b[^>]*\/>/g
const RELATIONSHIPS_PATTERN = /<Relationships\b[^>]*>[\s\S]*<\/Relationships>/
const RELATIONSHIPS_OPEN_PATTERN = /<Relationships\b[^>]*>/
const WORKSHEET_OVERRIDE_PATTERN = /<Override[^>]*worksheets\/[^"']*"[^>]*\/>/g
const SHEETS_SECTION_PATTERN = /<sheets\b[^>]*>[\s\S]*?<\/sheets>/
const PRINT_AREA_PATTERN =
  /<definedName([^>]*name="_xlnm\.Print_Area"[^>]*)>([\s\S]*?)<\/definedName>/g
const DEFINED_NAME_PATTERN = /<definedName([^>]*)>([\s\S]*?)<\/definedName>/
const DEFINED_NAMES_EMPTY_PATTERN = /<definedNames\s*\/>|<definedNames>\s*<\/definedNames>/g
const PRINT_AREA_STRIP_PATTERN =
  /<definedName[^>]*_xlnm\.Print_Area[^>]*>[\s\S]*?<\/definedName>/g
const SHEET_AREA_PATTERN = /^(.*!)(.*)$/
const REL_ATTR_PATTERN = /Id="([^"]+)"[^>]*Target="([^"]+)"/g
const WB_SHEET_TAG_PATTERN = /<sheet\b[^>]*>/g
const SHEET_DATA_OPEN_PATTERN = /<sheetData\b/
const SHEET_DATA_PATTERN = /<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/
const DIMENSION_PATTERN = /<dimension\b[^>]*\/>/
const DIMENSION_ANY_PATTERN = /<dimension\b/
const INLINE_TEXT_PATTERN = /<t[^>]*>([^<]*)<\/t>/
const SHARED_INDEX_PATTERN = /<v>([^<]*)<\/v>/
const IS_TEXT_PATTERN = /<is><t[^>]*>([^<]*)<\/t><\/is>/
const A1_PATTERN = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/
const MERGE_REF_PATTERN = /ref="([^"]+)"/g
const BRK_ID_PATTERN = /<brk\b[^>]*\bid="(\d+)"/g
const COL_LETTERS_PATTERN = /^\$?([A-Za-z]+)/
const DIGITS_PATTERN = /(\d+)/g
const SHEET_NAME_ILLEGAL_PATTERN = /[:\\/?*[\]]/g

interface WorkbookSheetInfo {
  name: string
  relId: string
  sheetId: string
  tag: string
}

interface XlsxPackage {
  order: string[]
  parts: ZipParts
  workbook: string
  sheets: WorkbookSheetInfo[]
  rels: Record<string, string>
  sheetPath: string
  shared: string[]
}

interface RenderBlock {
  rows: string[]
  merges: string[]
  breaks: number[]
  maxRow: number
  maxCol: number
}

interface LoopContext {
  prefix: string
  fields: Record<string, string>
}

interface LoopPlanEntry {
  templateRow: number
  count: number
}

/** 打印用：单 sheet 顺序铺 N 份模板块，块间插入分页符 */
export function renderPages(template: Uint8Array, docs: PrintDoc[]): Uint8Array {
  if (docs.length === 0) throw ERR_EMPTY_DOCS
  const pkg = openPackage(template)
  const blocks: RenderBlock[] = []
  for (const doc of docs) {
    blocks.push(expandSheet(pkg.parts.get(pkg.sheetPath)!, pkg.shared, doc))
  }
  const { rows, merges, breaks, dim } = stitchBlocks(blocks)
  const sheetOut = rebuildSheet(pkg.parts.get(pkg.sheetPath)!, rows, merges, breaks, dim)
  const wbOut = shiftPrintAreas(pkg.workbook, blocks)
  setPartText(pkg.parts, pkg.sheetPath, sheetOut)
  setPartText(pkg.parts, 'xl/workbook.xml', wbOut)
  return zipParts(pkg.parts, pkg.order)
}

/** 导出用：每份 doc 一个 sheet */
export function renderSheets(template: Uint8Array, docs: NamedDoc[]): Uint8Array {
  if (docs.length === 0) throw ERR_EMPTY_DOCS
  const pkg = openPackage(template)
  const templateSheet = pkg.parts.get(pkg.sheetPath)!
  const names = uniqueSheetNames(docs)

  const sheetEntries: string[] = []
  const relsEntries: string[] = []
  const overrides: string[] = []
  const newParts = new Map<string, Uint8Array>()

  for (let index = 0; index < docs.length; index++) {
    const named = docs[index]!
    const block = expandSheet(templateSheet, pkg.shared, named.doc)
    const dim = dimensionRef(block.maxCol, block.maxRow)
    const sheetXml = rebuildSheet(templateSheet, block.rows, block.merges, block.breaks, dim)
    const i = index + 1
    const partPath = `xl/worksheets/sheet_synie_${i}.xml`
    const rid = `rIdSynie${i}`
    sheetEntries.push(
      `<sheet name="${xmlEscape(names[index]!)}" sheetId="${1000 + i}" r:id="${rid}"/>`,
    )
    relsEntries.push(
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet_synie_${i}.xml"/>`,
    )
    overrides.push(
      `<Override PartName="/${partPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    newParts.set(partPath, textToBytes(sheetXml))
  }

  let wb = replaceSheetsSection(pkg.workbook, sheetEntries.join(''))
  wb = stripPrintAreas(wb)

  const relsPath = 'xl/_rels/workbook.xml.rels'
  const oldRels = bytesToText(pkg.parts.get(relsPath)!)
  const kept: string[] = []
  for (const tag of oldRels.match(REL_TAG_PATTERN) ?? []) {
    if (tag.includes('/worksheet') || tag.includes('worksheets/')) continue
    kept.push(tag)
  }
  const inner = [...kept, ...relsEntries].join('')
  const newRels = oldRels.replace(RELATIONSHIPS_PATTERN, (full) => {
    const open = full.match(RELATIONSHIPS_OPEN_PATTERN)?.[0] ?? '<Relationships>'
    return `${open}${inner}</Relationships>`
  })

  const ctPath = '[Content_Types].xml'
  let ct = bytesToText(pkg.parts.get(ctPath)!).replace(WORKSHEET_OVERRIDE_PATTERN, '')
  ct = ct.replace('</Types>', `${overrides.join('')}</Types>`)

  for (const sheet of pkg.sheets) {
    const resolved = resolveSheetPath(pkg.rels[sheet.relId] ?? '')
    if (resolved) pkg.parts.delete(resolved)
  }
  setPartText(pkg.parts, 'xl/workbook.xml', wb)
  setPartText(pkg.parts, relsPath, newRels)
  setPartText(pkg.parts, ctPath, ct)
  for (const [path, data] of newParts) {
    pkg.parts.set(path, data)
  }
  return zipParts(pkg.parts, pkg.order)
}

function replaceSheetsSection(wb: string, sheetsInner: string): string {
  return wb.replace(SHEETS_SECTION_PATTERN, `<sheets>${sheetsInner}</sheets>`)
}

function stripPrintAreas(wb: string): string {
  wb = wb.replace(PRINT_AREA_STRIP_PATTERN, '')
  return wb.replace(DEFINED_NAMES_EMPTY_PATTERN, '')
}

function openPackage(value: Uint8Array): XlsxPackage {
  let parts: ZipParts
  try {
    parts = unzipParts(value)
  } catch {
    throw invalidTemplate('不是有效的 xlsx（zip）文件')
  }
  const order = [...parts.keys()]
  const workbookBytes = parts.get('xl/workbook.xml')
  if (!workbookBytes) throw invalidTemplate('缺少 xl/workbook.xml')
  const relsRaw = parts.get('xl/_rels/workbook.xml.rels')
  if (!relsRaw) throw invalidTemplate('缺少 xl/_rels/workbook.xml.rels')

  const workbook = bytesToText(workbookBytes)
  const rels = parseRelationships(relsRaw)
  const sheets = parseWorkbookSheets(workbook)
  if (sheets.length === 0) throw invalidTemplate('workbook 中没有 sheet')
  const sheetPath = resolveSheetPath(rels[sheets[0]!.relId] ?? '')
  if (!sheetPath || !parts.has(sheetPath)) {
    throw invalidTemplate('找不到第一个 sheet 对应的 part')
  }
  const shared = parseSharedStrings(parts.get('xl/sharedStrings.xml'))
  return { order, parts, workbook, sheets, rels, sheetPath, shared }
}

function parseRelationships(value: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {}
  const text = bytesToText(value)
  REL_ATTR_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = REL_ATTR_PATTERN.exec(text)) !== null) {
    result[match[1]!] = match[2]!
  }
  return result
}

function parseWorkbookSheets(wb: string): WorkbookSheetInfo[] {
  const result: WorkbookSheetInfo[] = []
  for (const tag of wb.match(WB_SHEET_TAG_PATTERN) ?? []) {
    const name = xmlAttr(tag, 'name')
    let rid = xmlAttr(tag, 'r:id')
    if (!rid) rid = xmlAttr(tag, 'id')
    if (!rid || !name) continue
    result.push({ name, relId: rid, sheetId: xmlAttr(tag, 'sheetId'), tag })
  }
  return result
}

function resolveSheetPath(target: string): string {
  target = target.replace(/^\/+/, '')
  if (!target) return ''
  if (target.startsWith('xl/')) return target
  return cleanPartName(`xl/${target}`)
}

function expandSheet(sheetXml: Uint8Array, shared: string[], doc: PrintDoc): RenderBlock {
  const fields = doc.fields ?? {}
  const loops = doc.loops ?? {}
  const loopNames = new Set(Object.keys(loops))

  const sheet = bytesToText(sheetXml)
  ROW_PATTERN.lastIndex = 0
  const rows = sheet.match(ROW_PATTERN) ?? []
  if (rows.length === 0) throw invalidTemplate('sheet 中没有 row')

  const outRows: string[] = []
  let delta = 0
  const plan: LoopPlanEntry[] = []

  for (const row of rows) {
    const prefix = loopRowPrefix(row, shared, loopNames)
    if (!prefix) {
      outRows.push(fillRow(shiftRowXml(row, delta), shared, fields, loopNames, null))
      continue
    }
    const items = loops[prefix] ?? []
    const templateRow = rowNumber(row)
    for (let seq = 0; seq < items.length; seq++) {
      const item = items[seq]!
      const itemFields: Record<string, string> = { ...item, _seq: String(seq + 1) }
      outRows.push(
        fillRow(
          shiftRowXml(row, delta + seq),
          shared,
          fields,
          loopNames,
          { prefix, fields: itemFields },
        ),
      )
    }
    delta += items.length - 1
    plan.push({ templateRow, count: items.length })
  }

  const deltaBefore = (row: number): number => {
    let total = 0
    for (const entry of plan) {
      if (entry.templateRow < row) total += entry.count - 1
    }
    return total
  }

  const merges: string[] = []
  for (const ref of extractMergeRefs(sheet)) {
    const shifted = shiftMergeForLoops(ref, plan, deltaBefore)
    if (shifted) merges.push(shifted)
  }

  const breaks: number[] = []
  for (const b of extractRowBreaks(sheet)) {
    breaks.push(b + deltaBefore(b + 1))
  }

  let maxRow = 1
  for (const row of outRows) {
    const number = rowNumber(row)
    if (number > maxRow) maxRow = number
  }
  return {
    rows: outRows,
    merges,
    breaks,
    maxRow,
    maxCol: maxColumn(outRows),
  }
}

function loopRowPrefix(row: string, shared: string[], loopNames: Set<string>): string {
  CELL_PATTERN.lastIndex = 0
  for (const cell of row.match(CELL_PATTERN) ?? []) {
    const { text, ok } = cellText(cell, shared)
    if (!ok) continue
    PLACEHOLDER_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
      const name = match[1] ?? ''
      const index = name.indexOf('.')
      if (index >= 0) {
        const prefix = name.slice(0, index)
        if (loopNames.has(prefix)) return prefix
      }
    }
  }
  return ''
}

function fillRow(
  row: string,
  shared: string[],
  fields: Record<string, string>,
  loopNames: Set<string>,
  loop: LoopContext | null,
): string {
  return row.replace(CELL_PATTERN, (cell) => fillCell(cell, shared, fields, loopNames, loop))
}

function fillCell(
  cell: string,
  shared: string[],
  fields: Record<string, string>,
  loopNames: Set<string>,
  loop: LoopContext | null,
): string {
  const { text, ok } = cellText(cell, shared)
  if (!ok || !text.includes('${')) return cell
  const replaced = text.replace(/\$\{([^{}]+)\}/g, (_full, name: string) => {
    const index = name.indexOf('.')
    if (index < 0) return fields[name] ?? ''
    const prefix = name.slice(0, index)
    const rest = name.slice(index + 1)
    if (loop && loop.prefix === prefix) return loop.fields[rest] ?? ''
    if (loopNames.has(prefix)) return ''
    return fields[name] ?? ''
  })
  return replaceCellWithInline(cell, replaced)
}

function replaceCellWithInline(cell: string, text: string): string {
  let r = xmlAttr(cell, 'r')
  if (!r) r = 'A1'
  const s = xmlAttr(cell, 's')
  const sAttr = s ? ` s="${s}"` : ''
  return `<c r="${r}"${sAttr} t="inlineStr"><is><t>${xmlEscape(text)}</t></is></c>`
}

function cellText(cell: string, shared: string[]): { text: string; ok: boolean } {
  if (cell.includes('t="inlineStr"') || cell.includes("t='inlineStr'")) {
    const match = INLINE_TEXT_PATTERN.exec(cell)
    return { text: match ? xmlUnescape(match[1] ?? '') : '', ok: true }
  }
  if (cell.includes('t="s"') || cell.includes("t='s'")) {
    const match = SHARED_INDEX_PATTERN.exec(cell)
    if (!match) return { text: '', ok: false }
    const index = Number.parseInt(match[1] ?? '', 10)
    if (Number.isNaN(index) || index < 0 || index >= shared.length) {
      return { text: '', ok: false }
    }
    return { text: shared[index]!, ok: true }
  }
  const match = IS_TEXT_PATTERN.exec(cell)
  if (match) return { text: xmlUnescape(match[1] ?? ''), ok: true }
  return { text: '', ok: false }
}

function stitchBlocks(blocks: RenderBlock[]): {
  rows: string[]
  merges: string[]
  breaks: number[]
  dim: string
} {
  if (blocks.length === 1) {
    const only = blocks[0]!
    return {
      rows: only.rows,
      merges: only.merges,
      breaks: only.breaks,
      dim: dimensionRef(only.maxCol, only.maxRow),
    }
  }
  const rows: string[] = []
  const merges: string[] = []
  const breaks: number[] = []
  let offset = 0
  let maxCol = 1
  for (const block of blocks) {
    for (const row of block.rows) {
      rows.push(shiftRowXml(row, offset))
    }
    for (const ref of block.merges) {
      merges.push(shiftRef(ref, offset))
    }
    for (const b of block.breaks) {
      breaks.push(b + offset)
    }
    offset += block.maxRow
    breaks.push(offset)
    if (block.maxCol > maxCol) maxCol = block.maxCol
  }
  if (breaks.length > 0) breaks.pop()
  return {
    rows,
    merges,
    breaks: uniqueSortedInts(breaks),
    dim: dimensionRef(maxCol, offset),
  }
}

function shiftPrintAreas(wb: string, blocks: RenderBlock[]): string {
  if (blocks.length <= 1) return wb
  const offsets: number[] = []
  let offset = 0
  for (const block of blocks) {
    offsets.push(offset)
    offset += block.maxRow
  }
  return wb.replace(PRINT_AREA_PATTERN, (whole) => {
    if (
      !whole.includes('localSheetId="0"') &&
      !whole.includes("localSheetId='0'") &&
      whole.includes('localSheetId')
    ) {
      return whole
    }
    const match = DEFINED_NAME_PATTERN.exec(whole)
    if (!match) return whole
    const attrs = match[1] ?? ''
    const body = (match[2] ?? '').trim()
    const areaParts = SHEET_AREA_PATTERN.exec(body)
    if (!areaParts) return whole
    const prefix = areaParts[1] ?? ''
    const area = areaParts[2] ?? ''
    const areas = offsets.map((off) => prefix + shiftRef(area, off))
    return `<definedName${attrs}>${areas.join(',')}</definedName>`
  })
}

function rebuildSheet(
  template: Uint8Array,
  rows: string[],
  merges: string[],
  breaks: number[],
  dim: string,
): string {
  let sheet = bytesToText(template)
  const sheetData = `<sheetData>${rows.join('')}</sheetData>`
  if (!SHEET_DATA_OPEN_PATTERN.test(sheet)) throw invalidTemplate('sheet 缺少 sheetData')
  sheet = sheet.replace(SHEET_DATA_PATTERN, sheetData)

  if (DIMENSION_ANY_PATTERN.test(sheet)) {
    sheet = sheet.replace(DIMENSION_PATTERN, `<dimension ref="${dim}"/>`)
  } else {
    sheet = sheet.replace('<sheetData', `<dimension ref="${dim}"/><sheetData`)
  }

  let mergeXml = ''
  if (merges.length > 0) {
    const inner = merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')
    mergeXml = `<mergeCells count="${merges.length}">${inner}</mergeCells>`
  }
  sheet = sheet.replace(MERGE_PATTERN, '')
  if (mergeXml) {
    sheet = sheet.replace('</sheetData>', `</sheetData>${mergeXml}`)
  }

  let brksXml = ''
  if (breaks.length > 0) {
    const inner = breaks.map((id) => `<brk id="${id}" max="16383" man="1"/>`).join('')
    brksXml = `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${inner}</rowBreaks>`
  }
  sheet = sheet.replace(BRKS_PATTERN, '')
  if (brksXml) {
    if (sheet.includes('</worksheet>')) {
      sheet = sheet.replace('</worksheet>', `${brksXml}</worksheet>`)
    } else {
      sheet += brksXml
    }
  }
  return sheet
}

function shiftMergeForLoops(
  ref: string,
  plan: LoopPlanEntry[],
  deltaBefore: (row: number) => number,
): string | null {
  const [r1, r2] = refRowRange(ref)
  for (const entry of plan) {
    if (entry.templateRow === r1 && r1 === r2) return null
  }
  return shiftRefRows(ref, deltaBefore)
}

function refRowRange(ref: string): [number, number] {
  const matches = ref.match(DIGITS_PATTERN) ?? []
  if (matches.length === 0) return [0, 0]
  let min = 0
  let max = 0
  matches.forEach((text, index) => {
    const value = Number.parseInt(text, 10)
    if (Number.isNaN(value)) return
    if (index === 0 || value < min) min = value
    if (index === 0 || value > max) max = value
  })
  return [min, max]
}

function shiftRefRows(ref: string, deltaOf: (row: number) => number): string {
  return ref.replace(REF_PATTERN, (full, boundary, dollar1, col, dollar2, rowText) => {
    const row = Number.parseInt(rowText, 10)
    if (Number.isNaN(row)) return full
    return `${boundary}${dollar1}${col}${dollar2}${row + deltaOf(row)}`
  })
}

function shiftRef(ref: string, delta: number): string {
  if (delta === 0) return ref
  return shiftRefRows(ref, () => delta)
}

function shiftRowXml(row: string, delta: number): string {
  if (delta === 0) return row
  const r0 = rowNumber(row)
  const r1 = r0 + delta
  let shifted = row.replace(CELL_PATTERN, (cell) => {
    const ref = xmlAttr(cell, 'r')
    if (!ref) return cell
    return cell.replace(`r="${ref}"`, `r="${shiftA1(ref, delta)}"`)
  })
  const rowAttrPattern = new RegExp(`<row\\b([^>]*)\\br="${r0}"`)
  shifted = shifted.replace(rowAttrPattern, `<row$1 r="${r1}"`)
  return shifted
}

function shiftA1(ref: string, delta: number): string {
  const match = A1_PATTERN.exec(ref)
  if (!match) return ref
  const row = Number.parseInt(match[4] ?? '', 10)
  if (Number.isNaN(row)) return ref
  return `${match[1]}${match[2]}${match[3]}${row + delta}`
}

function rowNumber(row: string): number {
  const value = xmlAttr(row, 'r')
  if (!value) throw invalidTemplate('row 缺少 r 属性')
  const number = Number.parseInt(value, 10)
  if (Number.isNaN(number)) throw invalidTemplate('row 缺少 r 属性')
  return number
}

function extractMergeRefs(sheet: string): string[] {
  const block = sheet.match(MERGE_PATTERN)?.[0]
  if (!block) return []
  const result: string[] = []
  MERGE_REF_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MERGE_REF_PATTERN.exec(block)) !== null) {
    result.push(match[1]!)
  }
  return result
}

function extractRowBreaks(sheet: string): number[] {
  const block = sheet.match(BRKS_PATTERN)?.[0]
  if (!block) return []
  const result: number[] = []
  BRK_ID_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BRK_ID_PATTERN.exec(block)) !== null) {
    const id = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isNaN(id)) result.push(id)
  }
  return result
}

function maxColumn(rows: string[]): number {
  let max = 1
  for (const row of rows) {
    for (const cell of row.match(CELL_PATTERN) ?? []) {
      const index = colIndex(xmlAttr(cell, 'r'))
      if (index > max) max = index
    }
  }
  return max
}

function colIndex(ref: string): number {
  const match = COL_LETTERS_PATTERN.exec(ref)
  if (!match) return 1
  let index = 0
  for (const c of match[1]!.toUpperCase()) {
    index = index * 26 + (c.charCodeAt(0) - 64)
  }
  return index < 1 ? 1 : index
}

function dimensionRef(maxCol: number, maxRow: number): string {
  if (maxRow < 1) maxRow = 1
  return `A1:${colLetters(maxCol - 1)}${maxRow}`
}

function colLetters(n: number): string {
  if (n < 0) n = 0
  let result = ''
  for (;;) {
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26) - 1
    if (n < 0) return result
  }
}

function uniqueSheetNames(docs: NamedDoc[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const doc of docs) {
    const base = sanitizeSheetName(doc.name)
    let candidate = base
    for (let n = 1; ; n++) {
      if (!seen.has(candidate)) break
      const suffix = ` ${n}`
      const runes = [...base]
      let limit = 31 - [...suffix].length
      if (limit < 1) limit = 1
      candidate = runes.slice(0, limit).join('') + suffix
    }
    seen.add(candidate)
    result.push(candidate)
  }
  return result
}

function sanitizeSheetName(name: string): string {
  name = name.replace(SHEET_NAME_ILLEGAL_PATTERN, ' ').trim()
  if (!name) name = 'Sheet'
  const runes = [...name]
  if (runes.length > 31) return runes.slice(0, 31).join('')
  return name
}

export function xmlAttr(tag: string, name: string): string {
  const dq = new RegExp(`${escapeRegExp(name)}="([^"]*)"`).exec(tag)
  if (dq) return dq[1] ?? ''
  const sq = new RegExp(`${escapeRegExp(name)}='([^']*)'`).exec(tag)
  return sq?.[1] ?? ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function xmlUnescape(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
}

function uniqueSortedInts(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}
