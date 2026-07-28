import { describe, expect, test } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { renderPages, renderSheets, xmlUnescape } from './renderer.ts'
import type { PrintDoc } from './types.ts'

function workbookFixture(files: Record<string, string>): Uint8Array {
  const record: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(files)) {
    record[name] = strToU8(value)
  }
  return zipSync(record)
}

function readPart(value: Uint8Array, name: string): string {
  const parts = unzipSync(value)
  const data = parts[name]
  if (!data) throw new Error(`missing part ${name}`)
  return strFromU8(data)
}

function sheetCellTexts(sheet: string): string[] {
  const pattern = /<t[^>]*>([^<]*)<\/t>/g
  const result: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sheet)) !== null) {
    result.push(xmlUnescape(match[1] ?? ''))
  }
  return result
}

function rowNumbers(sheet: string): string[] {
  const pattern = /<row\b[^>]*\br="(\d+)"/g
  const result: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sheet)) !== null) {
    result.push(match[1]!)
  }
  return result
}

const renderTestWorkbook =
  `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets>` +
  `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'T'!$A$1:$C$4</definedName></definedNames>` +
  `</workbook>`

const renderTestRels =
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`

const renderTestContentTypes =
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`

function renderTestTemplate(): Uint8Array {
  return workbookFixture({
    'xl/workbook.xml': renderTestWorkbook,
    'xl/_rels/workbook.xml.rels': renderTestRels,
    '[Content_Types].xml': renderTestContentTypes,
    'xl/styles.xml': `<styleSheet/>`,
    'xl/sharedStrings.xml': `<sst><si><t>订单号：\${order_no}</t></si><si><t>\${party.name}</t></si></sst>`,
    'xl/worksheets/sheet1.xml':
      `<worksheet><dimension ref="A1:C4"/>` +
      `<sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>\${unknown_key}</t></is></c></row>` +
      `<row r="3"><c r="A3" t="inlineStr"><is><t>\${items._seq}</t></is></c><c r="B3" t="inlineStr"><is><t>\${items.material_name}</t></is></c><c r="C3" t="inlineStr"><is><t>\${items.qty}</t></is></c></row>` +
      `<row r="4"><c r="A4" t="inlineStr"><is><t>合计 \${gross_total}</t></is></c></row>` +
      `</sheetData>` +
      `<mergeCells count="2"><mergeCell ref="A3:C3"/><mergeCell ref="A4:C4"/></mergeCells>` +
      `<rowBreaks count="1" manualBreakCount="1"><brk id="1" max="16383" man="1"/></rowBreaks>` +
      `<pageSetup paperSize="9"/>` +
      `</worksheet>`,
  })
}

function renderTestDoc(): PrintDoc {
  return {
    fields: {
      order_no: 'SO-0001',
      'party.name': '测试客户',
      gross_total: '100.5',
    },
    loops: {
      items: [
        { material_name: '物料甲', qty: '2' },
        { material_name: '物料乙', qty: '3' },
      ],
    },
  }
}

describe('renderPages', () => {
  test('fills header loops and shifts layout', () => {
    const out = renderPages(renderTestTemplate(), [renderTestDoc()])
    const sheet = readPart(out, 'xl/worksheets/sheet1.xml')
    const texts = sheetCellTexts(sheet)
    const joined = texts.join('|')
    for (const want of ['订单号：SO-0001', '测试客户', '1', '物料甲', '2', '物料乙', '3', '合计 100.5']) {
      expect(joined).toContain(want)
    }
    expect(sheet).not.toContain('${')
    expect(rowNumbers(sheet).join(',')).toBe('1,3,4,5')
    expect(sheet).not.toContain('ref="A3:C3"')
    expect(sheet).toContain('ref="A5:C5"')
    expect(sheet).toContain('<brk id="1"')
    expect(sheet).toContain('<pageSetup paperSize="9"/>')
    expect(readPart(out, 'xl/styles.xml')).toBe('<styleSheet/>')
  })

  test('batch blocks offsets and print area', () => {
    const empty: PrintDoc = {
      fields: { order_no: 'SO-0002', 'party.name': '客户乙', gross_total: '7' },
      loops: { items: [] },
    }
    const out = renderPages(renderTestTemplate(), [renderTestDoc(), empty])
    const sheet = readPart(out, 'xl/worksheets/sheet1.xml')
    expect(rowNumbers(sheet).join(',')).toBe('1,3,4,5,6,8')
    const texts = sheetCellTexts(sheet).join('|')
    expect(texts).toContain('订单号：SO-0002')
    expect(sheet).toContain('<brk id="5"')
    expect(sheet).toContain('<brk id="6"')
    const wb = readPart(out, 'xl/workbook.xml')
    expect(wb).toContain("'T'!$A$1:$C$4,'T'!$A$6:$C$9")
  })
})

describe('renderSheets', () => {
  test('produces one sheet per doc with sanitized names', () => {
    const out = renderSheets(renderTestTemplate(), [
      { name: 'SO-0001', doc: renderTestDoc() },
      {
        name: 'SO/0002:超长单号截断测试用中文补齐三十一字节数统计一二三四五六七八九十',
        doc: renderTestDoc(),
      },
      { name: 'SO-0001', doc: renderTestDoc() },
    ])
    const wb = readPart(out, 'xl/workbook.xml')
    expect(wb).toContain('name="SO-0001"')
    expect(wb).toContain('name="SO-0001 1"')
    expect(wb).toContain('rIdSynie1')
    expect(wb).toContain('rIdSynie2')
    expect(wb).toContain('rIdSynie3')
    // illegal chars replaced
    expect(wb).not.toContain('SO/0002')
    const sheet1 = readPart(out, 'xl/worksheets/sheet_synie_1.xml')
    expect(sheetCellTexts(sheet1).join('|')).toContain('订单号：SO-0001')
  })
})
