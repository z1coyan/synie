/**
 * 共享银行流水导入文件解析：xlsx（zip+XML）与 BIFF8 .xls。
 * 行为对齐 server-go banking/parser.go。
 */
import { bytesToText, cleanPartName, decimal, unzipParts } from '@synie/shared'

export const MAX_BANK_IMPORT_ROWS = 5000

export function assertBankImportRowLimit(count: number): void {
  if (count > MAX_BANK_IMPORT_ROWS) {
    throw new Error(`数据行超过上限 ${MAX_BANK_IMPORT_ROWS} 行,请拆分文件后分次导入`)
  }
}
const EXCEL_FORMAT_ERROR =
  '无法读取文件:仅支持 Excel 的 xlsx/xls 格式' +
  '(部分银行导出的“xls”实为网页或文本,请用 Excel 打开后另存为 xlsx 再试)'

type CellKind = 'text' | 'date' | 'time' | 'datetime'

interface SheetCell {
  text: string
  native?: Date
  kind: CellKind
}

type SheetRow = Map<number, SheetCell>

export interface ParseTemplate {
  startRow: number
  datetimeCol: string | null
  datetimeFormat: string | null
  dateCol: string | null
  dateFormat: string | null
  timeCol: string | null
  timeFormat: string | null
  incomeCol: string | null
  expenseCol: string | null
  amountCol: string | null
  balanceCol: string | null
  counterpartyNameCol: string | null
  counterpartyAccountCol: string | null
  summaryCol: string | null
  noteCol: string | null
}

export interface ParsedImportItem {
  rowNo: number
  occurredAt: Date | null
  income: string | null
  expense: string | null
  balance: string | null
  counterpartyName: string | null
  counterpartyAccount: string | null
  summary: string | null
  note: string | null
  error: string | null
}

/** UTC 偏移毫秒，默认 +08:00（与 Go 8*time.Hour 一致） */
export function parseBankImport(
  template: ParseTemplate,
  content: Uint8Array,
  utcOffsetMs = 8 * 60 * 60 * 1000,
): ParsedImportItem[] {
  let rows: SheetRow[]
  if (content.length >= 2 && content[0] === 0x50 && content[1] === 0x4b) {
    rows = readXlsx(content)
  } else if (
    content.length >= 8 &&
    content[0] === 0xd0 &&
    content[1] === 0xcf &&
    content[2] === 0x11 &&
    content[3] === 0xe0
  ) {
    rows = readBiff8(content)
  } else {
    throw new Error(EXCEL_FORMAT_ERROR)
  }
  return buildImportItems(template, rows, utcOffsetMs)
}

function buildImportItems(
  template: ParseTemplate,
  rows: SheetRow[],
  utcOffsetMs: number,
): ParsedImportItem[] {
  const columns: Record<string, number> = {
    datetime: colIndex(template.datetimeCol),
    date: colIndex(template.dateCol),
    time: colIndex(template.timeCol),
    income: colIndex(template.incomeCol),
    expense: colIndex(template.expenseCol),
    amount: colIndex(template.amountCol),
    balance: colIndex(template.balanceCol),
    counterpartyName: colIndex(template.counterpartyNameCol),
    counterpartyAccount: colIndex(template.counterpartyAccountCol),
    summary: colIndex(template.summaryCol),
    note: colIndex(template.noteCol),
  }
  let start = template.startRow
  if (start < 1) start = 1
  const result: ParsedImportItem[] = []
  for (let rowIndex = start - 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? new Map()
    if (importRowBlank(row, columns)) continue
    result.push(buildImportItem(template, row, columns, rowIndex + 1, utcOffsetMs))
    assertBankImportRowLimit(result.length)
  }
  if (result.length === 0) {
    throw new Error(`没有可解析的数据行(数据起始行:第 ${template.startRow} 行)`)
  }
  return result
}

function buildImportItem(
  template: ParseTemplate,
  row: SheetRow,
  columns: Record<string, number>,
  rowNo: number,
  utcOffsetMs: number,
): ParsedImportItem {
  const messages: string[] = []
  let occurredAt: Date | null = null
  try {
    occurredAt = parseImportOccurredAt(template, row, columns, utcOffsetMs)
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err))
  }
  const [income, expense, amountErrors] = parseImportAmounts(template, row, columns)
  messages.push(...amountErrors)
  let balance: string | null = null
  try {
    balance = parseImportDecimal(importCell(row, columns.balance ?? 0))
  } catch (err) {
    messages.push(`余额「${err instanceof Error ? err.message : String(err)}」无法解析`)
    balance = null
  }
  let counterpartyName: string | null = null
  let counterpartyAccount: string | null = null
  let summary: string | null = null
  let note: string | null = null
  try {
    const c = importCell(row, columns.counterpartyName ?? 0)
    counterpartyName = parseImportText(c.cell, c.ok, 128, '对方户名')
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err))
  }
  try {
    const c = importCell(row, columns.counterpartyAccount ?? 0)
    counterpartyAccount = parseImportText(c.cell, c.ok, 64, '对方账号')
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err))
  }
  try {
    const c = importCell(row, columns.summary ?? 0)
    summary = parseImportText(c.cell, c.ok, 255, '摘要')
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err))
  }
  try {
    const c = importCell(row, columns.note ?? 0)
    note = parseImportText(c.cell, c.ok, 255, '备注')
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err))
  }
  return {
    rowNo,
    occurredAt,
    income,
    expense,
    balance,
    counterpartyName,
    counterpartyAccount,
    summary,
    note,
    error: messages.length > 0 ? messages.join(';') : null,
  }
}

function parseImportOccurredAt(
  template: ParseTemplate,
  row: SheetRow,
  columns: Record<string, number>,
  utcOffsetMs: number,
): Date {
  if (template.datetimeCol) {
    const { cell, ok } = importCell(row, columns.datetime ?? 0)
    if (!ok) throw new Error('交易时间为空')
    let local: Date
    if (cell.kind !== 'text' && cell.native) {
      local = cell.native
    } else {
      const parsed = parseTemplateDatetime(upper(template.datetimeFormat ?? ''), cell.text)
      if (!parsed) {
        throw new Error(
          `交易时间「${cell.text}」不符合格式 ${datetimeFormatLabel(upper(template.datetimeFormat ?? ''))}`,
        )
      }
      local = parsed
    }
    return new Date(local.getTime() - utcOffsetMs)
  }
  const dateCell = importCell(row, columns.date ?? 0)
  if (!dateCell.ok) throw new Error('交易日期为空')
  let date: Date
  if (dateCell.cell.kind !== 'text' && dateCell.cell.native) {
    date = dateCell.cell.native
  } else {
    const parsed = parseTemplateDate(upper(template.dateFormat ?? ''), dateCell.cell.text)
    if (!parsed) {
      throw new Error(
        `交易日期「${dateCell.cell.text}」不符合格式 ${dateFormatLabel(upper(template.dateFormat ?? ''))}`,
      )
    }
    date = parsed
  }
  let hour = 0
  let minute = 0
  let second = 0
  const timeCell = importCell(row, columns.time ?? 0)
  if (timeCell.ok) {
    if (timeCell.cell.kind !== 'text' && timeCell.cell.native) {
      hour = timeCell.cell.native.getUTCHours()
      minute = timeCell.cell.native.getUTCMinutes()
      second = timeCell.cell.native.getUTCSeconds()
    } else {
      const parsed = parseTemplateTime(upper(template.timeFormat ?? ''), timeCell.cell.text)
      if (!parsed) {
        throw new Error(
          `交易时间「${timeCell.cell.text}」不符合格式 ${timeFormatLabel(upper(template.timeFormat ?? ''))}`,
        )
      }
      hour = parsed.h
      minute = parsed.m
      second = parsed.s
    }
  }
  const local = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, second),
  )
  return new Date(local.getTime() - utcOffsetMs)
}

function parseImportAmounts(
  template: ParseTemplate,
  row: SheetRow,
  columns: Record<string, number>,
): [string | null, string | null, string[]] {
  if (template.amountCol) {
    try {
      const amount = parseImportDecimal(importCell(row, columns.amount ?? 0))
      if (amount == null) return [null, null, ['金额为空']]
      const d = decimal(amount)
      if (d.gt(0)) return [amount, null, []]
      if (d.lt(0)) return [null, d.abs().toFixed(), []]
      return [null, null, ['金额为零']]
    } catch (err) {
      return [null, null, [`金额「${err instanceof Error ? err.message : String(err)}」无法解析`]]
    }
  }
  let income: string | null = null
  let expense: string | null = null
  try {
    income = parseImportDecimal(importCell(row, columns.income ?? 0))
  } catch (err) {
    return [null, null, [`收入「${err instanceof Error ? err.message : String(err)}」无法解析`]]
  }
  if (income != null && decimal(income).isNegative()) {
    return [null, null, ['收入为负数,请检查金额列配置(负值请用带符号金额列模式)']]
  }
  try {
    expense = parseImportDecimal(importCell(row, columns.expense ?? 0))
  } catch (err) {
    return [null, null, [`支出「${err instanceof Error ? err.message : String(err)}」无法解析`]]
  }
  if (expense != null && decimal(expense).isNegative()) {
    return [null, null, ['支出为负数,请检查金额列配置(负值请用带符号金额列模式)']]
  }
  if (income != null && decimal(income).isZero()) income = null
  if (expense != null && decimal(expense).isZero()) expense = null
  if (income == null && expense == null) return [null, null, ['收入/支出均为空']]
  if (income != null && expense != null) return [null, null, ['收入与支出同时有值']]
  return [income, expense, []]
}

function parseImportDecimal(cell: { cell: SheetCell; ok: boolean }): string | null {
  if (!cell.ok) return null
  const raw = cellTextValue(cell.cell)
  const normalized = raw
    .replaceAll(',', '')
    .replaceAll('，', '')
    .replaceAll(' ', '')
    .replaceAll('¥', '')
    .replaceAll('￥', '')
    .replace(/^\+/, '')
  try {
    const d = decimal(normalized)
    return d.toFixed()
  } catch {
    throw new Error(raw)
  }
}

function parseImportText(
  cell: SheetCell,
  ok: boolean,
  max: number,
  label: string,
): string | null {
  if (!ok) return null
  const value = cellTextValue(cell)
  if ([...value].length > max) throw new Error(`${label}超过 ${max} 字`)
  return value
}

function importCell(row: SheetRow, column: number): { cell: SheetCell; ok: boolean } {
  if (column < 1) return { cell: { text: '', kind: 'text' }, ok: false }
  const cell = row.get(column)
  if (!cell || (cell.kind === 'text' && cell.text.trim() === '')) {
    return { cell: { text: '', kind: 'text' }, ok: false }
  }
  return { cell: { ...cell, text: cell.text.trim() }, ok: true }
}

function importRowBlank(row: SheetRow, columns: Record<string, number>): boolean {
  for (const column of Object.values(columns)) {
    if (importCell(row, column).ok) return false
  }
  return true
}

function colIndex(column: string | null | undefined): number {
  if (!column) return 0
  let result = 0
  for (const char of column.toUpperCase()) {
    if (char < 'A' || char > 'Z') return 0
    result = result * 26 + (char.charCodeAt(0) - 64)
  }
  return result
}

function cellTextValue(cell: SheetCell): string {
  if (cell.kind === 'text') return cell.text
  if (!cell.native) return cell.text
  if (cell.kind === 'date') return formatDate(cell.native)
  if (cell.kind === 'time') return formatTime(cell.native)
  return `${formatDate(cell.native)} ${formatTime(cell.native)}`
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTime(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  const s = String(d.getUTCSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function upper(value: string): string {
  return value.trim().toUpperCase()
}

function parseTemplateDatetime(format: string, value: string): Date | null {
  const layouts: Record<string, RegExp> = {
    YMD_DASH_HMS: /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    YMD_DASH_HM: /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})$/,
    YMD_SLASH_HMS: /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    YMD_SLASH_HM: /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2})$/,
    COMPACT_SPACE: /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/,
    COMPACT: /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
    ISO_T: /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    CN_HMS: /^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    MDY_SLASH_HMS: /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    DMY_SLASH_HMS: /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
  }
  const re = layouts[format]
  if (!re) return null
  const m = re.exec(value.trim())
  if (!m) return null
  if (format === 'MDY_SLASH_HMS') {
    return utcDate(+m[3]!, +m[1]!, +m[2]!, +m[4]!, +m[5]!, +m[6]!)
  }
  if (format === 'DMY_SLASH_HMS') {
    return utcDate(+m[3]!, +m[2]!, +m[1]!, +m[4]!, +m[5]!, +m[6]!)
  }
  return utcDate(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
}

function parseTemplateDate(format: string, value: string): Date | null {
  const layouts: Record<string, RegExp> = {
    YMD_DASH: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    YMD_SLASH: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
    YMD_COMPACT: /^(\d{4})(\d{2})(\d{2})$/,
    YMD_DOT: /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/,
    YMD_CN: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
    MDY_SLASH: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    DMY_SLASH: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    DMY_DASH: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
  }
  const re = layouts[format]
  if (!re) return null
  const m = re.exec(value.trim())
  if (!m) return null
  if (format === 'MDY_SLASH') return utcDate(+m[3]!, +m[1]!, +m[2]!, 0, 0, 0)
  if (format === 'DMY_SLASH' || format === 'DMY_DASH') {
    return utcDate(+m[3]!, +m[2]!, +m[1]!, 0, 0, 0)
  }
  return utcDate(+m[1]!, +m[2]!, +m[3]!, 0, 0, 0)
}

function parseTemplateTime(
  format: string,
  value: string,
): { h: number; m: number; s: number } | null {
  const layouts: Record<string, RegExp> = {
    HMS: /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    HM: /^(\d{1,2}):(\d{1,2})$/,
    HMS_COMPACT: /^(\d{2})(\d{2})(\d{2})$/,
    HMS_CN: /^(\d{1,2})时(\d{1,2})分(\d{1,2})秒$/,
  }
  const re = layouts[format]
  if (!re) return null
  const m = re.exec(value.trim())
  if (!m) return null
  return { h: +m[1]!, m: +m[2]!, s: +(m[3] ?? 0) }
}

function utcDate(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s))
}

function datetimeFormatLabel(value: string): string {
  return (
    {
      YMD_DASH_HMS: 'YYYY-MM-DD HH:mm:ss',
      YMD_DASH_HM: 'YYYY-MM-DD HH:mm',
      YMD_SLASH_HMS: 'YYYY/MM/DD HH:mm:ss',
      YMD_SLASH_HM: 'YYYY/MM/DD HH:mm',
      COMPACT_SPACE: 'YYYYMMDD HHmmss',
      COMPACT: 'YYYYMMDDHHmmss',
      ISO_T: 'YYYY-MM-DDTHH:mm:ss',
      CN_HMS: 'YYYY年MM月DD日 HH:mm:ss',
      MDY_SLASH_HMS: 'MM/DD/YYYY HH:mm:ss',
      DMY_SLASH_HMS: 'DD/MM/YYYY HH:mm:ss',
    }[value] ?? value
  )
}

function dateFormatLabel(value: string): string {
  return (
    {
      YMD_DASH: 'YYYY-MM-DD',
      YMD_SLASH: 'YYYY/MM/DD',
      YMD_COMPACT: 'YYYYMMDD',
      YMD_DOT: 'YYYY.MM.DD',
      YMD_CN: 'YYYY年MM月DD日',
      MDY_SLASH: 'MM/DD/YYYY',
      DMY_SLASH: 'DD/MM/YYYY',
      DMY_DASH: 'DD-MM-YYYY',
    }[value] ?? value
  )
}

function timeFormatLabel(value: string): string {
  return (
    {
      HMS: 'HH:mm:ss',
      HM: 'HH:mm',
      HMS_COMPACT: 'HHmmss',
      HMS_CN: 'HH时mm分ss秒',
    }[value] ?? value
  )
}

// ---- xlsx ----

function readXlsx(content: Uint8Array): SheetRow[] {
  let parts
  try {
    parts = unzipParts(content)
  } catch {
    throw new Error(EXCEL_FORMAT_ERROR)
  }
  const workbookXml = parts.get('xl/workbook.xml')
  if (!workbookXml) throw new Error(EXCEL_FORMAT_ERROR)
  const workbookText = bytesToText(workbookXml)
  const date1904 = /date1904\s*=\s*"1"/.test(workbookText) || /date1904\s*=\s*"true"/i.test(workbookText)
  const sheetMatch = /<sheet\b([^>]*)\/?>/.exec(workbookText)
  if (!sheetMatch) throw new Error('文件中没有工作表')
  const sheetAttrs = sheetMatch[1] ?? ''
  const rid =
    /\br:id="([^"]+)"/.exec(sheetAttrs)?.[1] ?? /\bid="([^"]+)"/.exec(sheetAttrs)?.[1]
  if (!rid) throw new Error(EXCEL_FORMAT_ERROR)
  const rels = parts.get('xl/_rels/workbook.xml.rels')
  if (!rels) throw new Error(EXCEL_FORMAT_ERROR)
  let target = ''
  const relPattern = /<Relationship\b([^>]*)\/?>/g
  let rm: RegExpExecArray | null
  const relText = bytesToText(rels)
  while ((rm = relPattern.exec(relText)) !== null) {
    const attrs = rm[1] ?? ''
    if (/\bId="([^"]+)"/.exec(attrs)?.[1] !== rid) continue
    target = /\bTarget="([^"]+)"/.exec(attrs)?.[1] ?? ''
    break
  }
  if (!target) throw new Error('工作表解析失败')
  target = target.replace(/^\/+/, '')
  if (!target.startsWith('xl/')) target = cleanPartName(`xl/${target}`)
  else target = cleanPartName(target)
  const sheetBytes = parts.get(target)
  if (!sheetBytes) throw new Error('工作表解析失败')
  const shared = parseShared(parts.get('xl/sharedStrings.xml'))
  const styles = parseStyles(parts.get('xl/styles.xml'))
  return parseWorksheet(bytesToText(sheetBytes), shared, styles, date1904)
}

function parseShared(raw: Uint8Array | undefined): string[] {
  if (!raw) return []
  const xml = bytesToText(raw)
  const result: string[] = []
  const siPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = siPattern.exec(xml)) !== null) {
    const body = m[1] ?? ''
    let text = ''
    const tPattern = /<t\b[^>]*>([^<]*)<\/t>/g
    let t: RegExpExecArray | null
    while ((t = tPattern.exec(body)) !== null) text += t[1] ?? ''
    result.push(decodeXml(text))
  }
  return result
}

interface StylesInfo {
  formats: Map<number, string>
  xfs: number[]
}

function parseStyles(raw: Uint8Array | undefined): StylesInfo {
  const formats = new Map<number, string>()
  const xfs: number[] = []
  if (!raw) return { formats, xfs }
  const xml = bytesToText(raw)
  const fmtPattern = /<numFmt\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = fmtPattern.exec(xml)) !== null) {
    const attrs = m[1] ?? ''
    const id = Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? NaN)
    const code = /\bformatCode="([^"]*)"/.exec(attrs)?.[1] ?? ''
    if (!Number.isNaN(id)) formats.set(id, decodeXml(code))
  }
  const xfPattern = /<xf\b([^>]*)\/?>/g
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  while ((m = xfPattern.exec(cellXfs)) !== null) {
    const attrs = m[1] ?? ''
    xfs.push(Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? 0))
  }
  return { formats, xfs }
}

function parseWorksheet(
  sheet: string,
  shared: string[],
  styles: StylesInfo,
  date1904: boolean,
): SheetRow[] {
  let maxRow = 0
  const rowPattern = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g
  const collected: { num: number; cells: Map<number, SheetCell> }[] = []
  let rm: RegExpExecArray | null
  while ((rm = rowPattern.exec(sheet)) !== null) {
    const attrs = rm[1] ?? ''
    const body = rm[2] ?? ''
    const num = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0)
    if (num < 1) continue
    if (num > maxRow) maxRow = num
    const row = new Map<number, SheetCell>()
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm: RegExpExecArray | null
    while ((cm = cellPattern.exec(body)) !== null) {
      const cattrs = cm[1] ?? ''
      const cbody = cm[2] ?? ''
      const ref = /\br="([^"]+)"/.exec(cattrs)?.[1] ?? ''
      const column = xlsxColumn(ref)
      if (column < 1) continue
      const type = /\bt="([^"]+)"/.exec(cattrs)?.[1] ?? ''
      const style = Number(/\bs="(\d+)"/.exec(cattrs)?.[1] ?? -1)
      const v = /<v>([^<]*)<\/v>/.exec(cbody)?.[1] ?? ''
      const inlineTexts: string[] = []
      const tPattern = /<t\b[^>]*>([^<]*)<\/t>/g
      let tm: RegExpExecArray | null
      while ((tm = tPattern.exec(cbody)) !== null) inlineTexts.push(decodeXml(tm[1] ?? ''))
      const cell = convertCell(type, v, inlineTexts.join(''), style, shared, styles, date1904)
      if (cell) row.set(column, cell)
    }
    collected.push({ num, cells: row })
  }
  const rows: SheetRow[] = Array.from({ length: maxRow }, () => new Map())
  for (const item of collected) {
    rows[item.num - 1] = item.cells
  }
  return rows
}

function convertCell(
  type: string,
  value: string,
  inline: string,
  style: number,
  shared: string[],
  styles: StylesInfo,
  date1904: boolean,
): SheetCell | null {
  if (type === 'inlineStr') return { text: inline, kind: 'text' }
  if (type === 's') {
    const index = Number.parseInt(value.trim(), 10)
    if (Number.isNaN(index) || index < 0 || index >= shared.length) return null
    return { text: shared[index]!, kind: 'text' }
  }
  if (type === 'b') return { text: value.trim() === '1' ? 'true' : 'false', kind: 'text' }
  if (type === 'str' || type === 'e') return { text: value, kind: 'text' }
  const raw = value.trim()
  if (raw === '') return null
  const formatId = style >= 0 && style < styles.xfs.length ? styles.xfs[style]! : 0
  const code = styles.formats.get(formatId) ?? ''
  const kind = excelDateKind(formatId, code)
  if (kind !== 'text') {
    const serial = Number.parseFloat(raw)
    if (!Number.isNaN(serial)) {
      return { text: raw, native: excelSerialTime(serial, date1904), kind }
    }
  }
  return { text: raw, kind: 'text' }
}

function xlsxColumn(reference: string): number {
  let result = 0
  for (const char of reference) {
    if (char < 'A' || char > 'Z') break
    result = result * 26 + (char.charCodeAt(0) - 64)
  }
  return result
}

function excelSerialTime(value: number, date1904: boolean): Date {
  const base = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, 30)
  const days = Math.floor(value)
  const fraction = value - days
  const seconds = Math.round(fraction * 86400)
  return new Date(base + days * 86400000 + seconds * 1000)
}

function excelDateKind(id: number, code: string): CellKind {
  if ([14, 15, 16, 17].includes(id)) return 'date'
  if ([18, 19, 20, 21, 45, 46, 47].includes(id)) return 'time'
  if (id === 22) return 'datetime'
  if (!code) return 'text'
  const normalized = normalizeExcelFormat(code)
  const hasDate = /[yd]/.test(normalized)
  const hasTime = /[hs]/.test(normalized)
  if (hasDate && hasTime) return 'datetime'
  if (hasDate) return 'date'
  if (hasTime) return 'time'
  return 'text'
}

function normalizeExcelFormat(code: string): string {
  let result = ''
  let inQuote = false
  let inBracket = false
  let escaped = false
  for (const char of code.toLowerCase()) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inQuote = !inQuote
      continue
    }
    if (char === '[') {
      inBracket = true
      continue
    }
    if (char === ']') {
      inBracket = false
      continue
    }
    if (!inQuote && !inBracket) result += char
  }
  return result
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}


// ---- BIFF8 / CFB (.xls) 对齐 server-go parser.go ----

const CFB_FREE = 0xffffffff
const CFB_EOC = 0xfffffffe
const CFB_FAT = 0xfffffffd
const CFB_DIFAT = 0xfffffffc
const CFB_MAX_CHAIN = 1 << 20

interface CompoundDirEntry {
  name: string
  kind: number
  start: number
  size: number
}

class CompoundFile {
  data: Uint8Array
  sectorSize: number
  miniSectorSize: number
  miniCutoff: number
  fat: number[] = []
  miniFat: number[] = []
  miniStream: Uint8Array = new Uint8Array(0)
  entries: CompoundDirEntry[] = []

  constructor(
    data: Uint8Array,
    sectorSize: number,
    miniSectorSize: number,
    miniCutoff: number,
  ) {
    this.data = data
    this.sectorSize = sectorSize
    this.miniSectorSize = miniSectorSize
    this.miniCutoff = miniCutoff
  }

  sector(id: number): Uint8Array {
    const offset = (id + 1) * this.sectorSize
    const end = offset + this.sectorSize
    if (end > this.data.length) throw new Error('unexpected EOF')
    return this.data.subarray(offset, end)
  }

  readRegularChain(start: number): Uint8Array {
    const parts: Uint8Array[] = []
    let total = 0
    const seen = new Set<number>()
    let id = start
    while (isNormalSector(id)) {
      if (seen.size > CFB_MAX_CHAIN) throw new Error('compound chain too long')
      if (seen.has(id) || id >= this.fat.length) throw new Error('invalid compound chain')
      seen.add(id)
      const sec = this.sector(id)
      parts.push(sec)
      total += sec.length
      id = this.fat[id]!
    }
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  readStream(entry: CompoundDirEntry): Uint8Array {
    let result: Uint8Array
    if (entry.size < this.miniCutoff) {
      const parts: Uint8Array[] = []
      let total = 0
      const seen = new Set<number>()
      let id = entry.start
      while (isNormalSector(id)) {
        if (seen.has(id) || id >= this.miniFat.length) throw new Error('invalid compound mini chain')
        seen.add(id)
        const offset = id * this.miniSectorSize
        const end = offset + this.miniSectorSize
        if (end > this.miniStream.length) throw new Error('unexpected EOF')
        const chunk = this.miniStream.subarray(offset, end)
        parts.push(chunk)
        total += chunk.length
        id = this.miniFat[id]!
      }
      result = new Uint8Array(total)
      let o = 0
      for (const p of parts) {
        result.set(p, o)
        o += p.length
      }
    } else {
      result = this.readRegularChain(entry.start)
    }
    if (result.length < entry.size) throw new Error('unexpected EOF')
    return result.subarray(0, entry.size)
  }
}

function isNormalSector(id: number): boolean {
  return id !== CFB_FREE && id !== CFB_EOC && id !== CFB_FAT && id !== CFB_DIFAT
}

function readU16LE(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8)
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  )
}

function readF64LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset + off, 8).getFloat64(0, true)
}

function parseCompoundFile(content: Uint8Array): CompoundFile {
  if (content.length < 512) throw new Error(EXCEL_FORMAT_ERROR)
  const sectorShift = readU16LE(content, 30)
  const miniShift = readU16LE(content, 32)
  if (sectorShift < 9 || sectorShift > 12 || miniShift !== 6) {
    throw new Error(EXCEL_FORMAT_ERROR)
  }
  const file = new CompoundFile(
    content,
    1 << sectorShift,
    1 << miniShift,
    readU32LE(content, 56),
  )
  const fatSectorIDs: number[] = []
  for (let offset = 76; offset + 4 <= 512; offset += 4) {
    const id = readU32LE(content, offset)
    if (id !== CFB_FREE) fatSectorIDs.push(id)
  }
  let nextDifat = readU32LE(content, 68)
  const difatCount = readU32LE(content, 72)
  for (let count = 0; count < difatCount && isNormalSector(nextDifat); count++) {
    const sector = file.sector(nextDifat)
    for (let offset = 0; offset + 4 < sector.length; offset += 4) {
      const id = readU32LE(sector, offset)
      if (id !== CFB_FREE) fatSectorIDs.push(id)
    }
    nextDifat = readU32LE(sector, sector.length - 4)
  }
  for (const id of fatSectorIDs) {
    const sector = file.sector(id)
    for (let offset = 0; offset + 4 <= sector.length; offset += 4) {
      file.fat.push(readU32LE(sector, offset))
    }
  }
  const directory = file.readRegularChain(readU32LE(content, 48))
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const entry = directory.subarray(offset, offset + 128)
    const nameLength = readU16LE(entry, 64)
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) continue
    const units: number[] = []
    for (let index = 0; index + 2 < nameLength; index += 2) {
      units.push(readU16LE(entry, index))
    }
    file.entries.push({
      name: String.fromCharCode(...units),
      kind: entry[66]!,
      start: readU32LE(entry, 116),
      size: Number(
        (BigInt(readU32LE(entry, 120)) | (BigInt(readU32LE(entry, 124)) << 32n)),
      ),
    })
  }
  const root = file.entries.find((e) => e.kind === 5)
  if (!root) throw new Error(EXCEL_FORMAT_ERROR)
  let miniStream = file.readRegularChain(root.start)
  if (miniStream.length > root.size) miniStream = miniStream.subarray(0, root.size)
  file.miniStream = miniStream
  const miniFatStart = readU32LE(content, 60)
  const miniFatCount = readU32LE(content, 64)
  if (miniFatCount > 0 && isNormalSector(miniFatStart)) {
    let miniFatBytes = file.readRegularChain(miniFatStart)
    const maxBytes = miniFatCount * file.sectorSize
    if (maxBytes < miniFatBytes.length) miniFatBytes = miniFatBytes.subarray(0, maxBytes)
    for (let offset = 0; offset + 4 <= miniFatBytes.length; offset += 4) {
      file.miniFat.push(readU32LE(miniFatBytes, offset))
    }
  }
  return file
}

function readBiff8(content: Uint8Array): SheetRow[] {
  let compound: CompoundFile
  try {
    compound = parseCompoundFile(content)
  } catch {
    throw new Error(EXCEL_FORMAT_ERROR)
  }
  let workbook: Uint8Array | null = null
  try {
    for (const entry of compound.entries) {
      if (entry.kind === 2 && (entry.name === 'Workbook' || entry.name === 'Book')) {
        workbook = compound.readStream(entry)
        break
      }
    }
  } catch {
    throw new Error(EXCEL_FORMAT_ERROR)
  }
  if (!workbook || workbook.length === 0) throw new Error(EXCEL_FORMAT_ERROR)
  try {
    return parseBiffWorkbook(workbook)
  } catch {
    throw new Error(EXCEL_FORMAT_ERROR)
  }
}

interface BiffRecord {
  id: number
  payload: Uint8Array
}

function biffRecords(content: Uint8Array): BiffRecord[] {
  const records: BiffRecord[] = []
  let offset = 0
  while (offset + 4 <= content.length) {
    const id = readU16LE(content, offset)
    const size = readU16LE(content, offset + 2)
    offset += 4
    if (size < 0 || offset + size > content.length) throw new Error('unexpected EOF')
    records.push({ id, payload: content.subarray(offset, offset + size) })
    offset += size
    if (id === 0x000a && offset >= content.length) break
  }
  return records
}

function parseBiffWorkbook(content: Uint8Array): SheetRow[] {
  const records = biffRecords(content)
  let firstSheet = 0
  let shared: string[] = []
  const xfs: number[] = []
  const formats = new Map<number, string>()
  let date1904 = false
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    switch (record.id) {
      case 0x0085: // BOUNDSHEET
        if (firstSheet === 0 && record.payload.length >= 8) {
          firstSheet = readU32LE(record.payload, 0)
        }
        break
      case 0x00e0: // XF
        if (record.payload.length >= 4) {
          xfs.push(readU16LE(record.payload, 2))
        }
        break
      case 0x041e: // FORMAT
        if (record.payload.length >= 5) {
          const id = readU16LE(record.payload, 0)
          try {
            const { value } = parseBiffUnicode(record.payload.subarray(2), true)
            formats.set(id, value)
          } catch {
            // ignore
          }
        }
        break
      case 0x0022: // DATEMODE
        date1904 =
          record.payload.length >= 2 && readU16LE(record.payload, 0) === 1
        break
      case 0x00fc: {
        // SST
        const chunks: Uint8Array[] = [record.payload]
        let total = record.payload.length
        for (let next = index + 1; next < records.length && records[next]!.id === 0x003c; next++) {
          chunks.push(records[next]!.payload)
          total += records[next]!.payload.length
        }
        const payload = new Uint8Array(total)
        let o = 0
        for (const c of chunks) {
          payload.set(c, o)
          o += c.length
        }
        try {
          shared = parseBiffSst(payload)
        } catch {
          shared = []
        }
        break
      }
    }
  }
  if (firstSheet === 0 || firstSheet >= content.length) {
    throw new Error('first BIFF sheet missing')
  }
  const sheetRecords = biffRecords(content.subarray(firstSheet))
  const rows: SheetRow[] = []
  const setCell = (rowIndex: number, columnIndex: number, cell: SheetCell) => {
    while (rows.length <= rowIndex) rows.push(new Map())
    const row = rows[rowIndex]!
    row.set(columnIndex + 1, cell)
  }
  const convertNumber = (value: number, xf: number): SheetCell => {
    let formatId = 0
    if (xf < xfs.length) formatId = xfs[xf]!
    const kind = excelDateKind(formatId, formats.get(formatId) ?? '')
    if (kind !== 'text') {
      return { text: formatBiffNumber(value), native: excelSerialTime(value, date1904), kind }
    }
    return { text: formatBiffNumber(value), kind: 'text' }
  }
  let pendingFormulaRow = -1
  let pendingFormulaColumn = -1
  for (const record of sheetRecords) {
    const payload = record.payload
    switch (record.id) {
      case 0x0203: // NUMBER
        if (payload.length >= 14) {
          const [row, column] = biffCellPosition(payload)
          const xf = readU16LE(payload, 4)
          const value = readF64LE(payload, 6)
          setCell(row, column, convertNumber(value, xf))
        }
        break
      case 0x027e: // RK
        if (payload.length >= 10) {
          const [row, column] = biffCellPosition(payload)
          const xf = readU16LE(payload, 4)
          setCell(row, column, convertNumber(decodeRk(payload.subarray(6, 10)), xf))
        }
        break
      case 0x00bd: // MULRK
        if (payload.length >= 12) {
          const row = readU16LE(payload, 0)
          const firstColumn = readU16LE(payload, 2)
          const count = Math.floor((payload.length - 6) / 6)
          for (let index = 0; index < count; index++) {
            const offset = 4 + index * 6
            const xf = readU16LE(payload, offset)
            setCell(
              row,
              firstColumn + index,
              convertNumber(decodeRk(payload.subarray(offset + 2, offset + 6)), xf),
            )
          }
        }
        break
      case 0x00fd: // LABELSST
        if (payload.length >= 10) {
          const [row, column] = biffCellPosition(payload)
          const index = readU32LE(payload, 6)
          if (index < shared.length) {
            setCell(row, column, { text: shared[index]!, kind: 'text' })
          }
        }
        break
      case 0x0204: // LABEL
        if (payload.length >= 9) {
          const [row, column] = biffCellPosition(payload)
          try {
            const { value } = parseBiffUnicode(payload.subarray(6), true)
            setCell(row, column, { text: value, kind: 'text' })
          } catch {
            // ignore
          }
        }
        break
      case 0x0205: // BOOLERR
        if (payload.length >= 8) {
          const [row, column] = biffCellPosition(payload)
          setCell(row, column, { text: payload[6]! !== 0 ? 'true' : 'false', kind: 'text' })
        }
        break
      case 0x0006: // FORMULA
        if (payload.length >= 14 && payload[6] === 0xff && payload[7] === 0xff) {
          const [row, column] = biffCellPosition(payload)
          switch (payload[8]) {
            case 0:
              pendingFormulaRow = row
              pendingFormulaColumn = column
              break
            case 1:
              setCell(row, column, {
                text: payload[9]! !== 0 ? 'true' : 'false',
                kind: 'text',
              })
              break
            case 2:
              setCell(row, column, { text: biffErrorText(payload[9]!), kind: 'text' })
              break
          }
        } else if (payload.length >= 14) {
          const [row, column] = biffCellPosition(payload)
          const xf = readU16LE(payload, 4)
          const value = readF64LE(payload, 6)
          setCell(row, column, convertNumber(value, xf))
        }
        break
      case 0x0207: // STRING
        if (pendingFormulaRow >= 0) {
          try {
            const { value } = parseBiffUnicode(payload, true)
            setCell(pendingFormulaRow, pendingFormulaColumn, { text: value, kind: 'text' })
          } catch {
            // ignore
          }
          pendingFormulaRow = -1
          pendingFormulaColumn = -1
        }
        break
      case 0x000a: // EOF
        return rows
    }
  }
  return rows
}

function biffErrorText(code: number): string {
  return (
    {
      0x00: '#NULL!',
      0x07: '#DIV/0!',
      0x0f: '#VALUE!',
      0x17: '#REF!',
      0x1d: '#NAME?',
      0x24: '#NUM!',
      0x2a: '#N/A',
    }[code] ?? '#ERR'
  )
}

function biffCellPosition(payload: Uint8Array): [number, number] {
  return [readU16LE(payload, 0), readU16LE(payload, 2)]
}

function decodeRk(raw: Uint8Array): number {
  const value = readU32LE(raw, 0)
  let result: number
  if (value & 2) {
    // signed 30-bit integer
    result = value >> 2
    if (result & 0x20000000) result = result - 0x40000000
  } else {
    const hi = (value & ~3) >>> 0
    const bits = BigInt(hi) << 32n
    const buf = new ArrayBuffer(8)
    new DataView(buf).setBigUint64(0, bits, true)
    result = new DataView(buf).getFloat64(0, true)
  }
  if (value & 1) result /= 100
  return result
}

function formatBiffNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  return String(value)
}

function parseBiffSst(payload: Uint8Array): string[] {
  if (payload.length < 8) throw new Error('unexpected EOF')
  const count = readU32LE(payload, 4)
  const result: string[] = []
  let offset = 8
  while (result.length < count && offset < payload.length) {
    const { value, consumed } = parseBiffUnicode(payload.subarray(offset), true)
    result.push(value)
    offset += consumed
  }
  return result
}

function parseBiffUnicode(
  payload: Uint8Array,
  longLength: boolean,
): { value: string; consumed: number } {
  const lengthBytes = longLength ? 2 : 1
  if (payload.length < lengthBytes + 1) throw new Error('unexpected EOF')
  let charCount = payload[0]!
  if (longLength) charCount = readU16LE(payload, 0)
  let offset = lengthBytes
  const flags = payload[offset]!
  offset++
  let richRuns = 0
  let extendedSize = 0
  if (flags & 0x08) {
    if (offset + 2 > payload.length) throw new Error('unexpected EOF')
    richRuns = readU16LE(payload, offset)
    offset += 2
  }
  if (flags & 0x04) {
    if (offset + 4 > payload.length) throw new Error('unexpected EOF')
    extendedSize = readU32LE(payload, offset)
    offset += 4
  }
  const width = flags & 0x01 ? 2 : 1
  const charBytes = charCount * width
  const end = offset + charBytes
  const consumed = end + richRuns * 4 + extendedSize
  if (consumed > payload.length) throw new Error('unexpected EOF')
  if (width === 1) {
    let value = ''
    for (let i = offset; i < end; i++) value += String.fromCharCode(payload[i]!)
    return { value, consumed }
  }
  const units: number[] = []
  for (let i = 0; i < charCount; i++) {
    units.push(readU16LE(payload, offset + i * 2))
  }
  return { value: String.fromCharCode(...units), consumed }
}
