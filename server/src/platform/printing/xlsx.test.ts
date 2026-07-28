import { describe, expect, test } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { extractPlaceholders } from './xlsx.ts'

function workbookFixture(files: Record<string, string>): Uint8Array {
  const record: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(files)) {
    record[name] = strToU8(value)
  }
  return zipSync(record)
}

describe('extractPlaceholders', () => {
  test('reads only first sheet and sharedStrings', () => {
    const value = workbookFixture({
      'xl/workbook.xml':
        `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      'xl/sharedStrings.xml':
        `<sst><si><t>\${order_no}</t></si><si><r><t>\${items.qty}</t></r><r><t> \${items._seq}</t></r></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="inlineStr"><is><t>\${company.name}</t></is></c></row></sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml':
        `<worksheet><sheetData><row><c t="inlineStr"><is><t>\${must_not_appear}</t></is></c></row></sheetData></worksheet>`,
    })
    const got = extractPlaceholders(value)
    expect(got.fields.join(',')).toBe('order_no')
    expect(got.nested['company']?.join(',')).toBe('name')
    expect(got.nested['items']?.join(',')).toBe('_seq,qty')
    expect(Object.keys(got.nested).sort().join(',')).toBe('company,items')
  })

  test('rejects malformed workbook with Chinese messages', () => {
    expect(() => extractPlaceholders(new TextEncoder().encode('nope'))).toThrow(
      '无法解析模板: 不是有效的 xlsx（zip）文件',
    )
    expect(() => extractPlaceholders(workbookFixture({}))).toThrow(
      '无法解析模板: 缺少 xl/workbook.xml',
    )
    expect(() =>
      extractPlaceholders(
        workbookFixture({
          'xl/workbook.xml':
            `<workbook><sheets><sheet name="A" sheetId="1" id="rId1"/></sheets></workbook>`,
        }),
      ),
    ).toThrow('无法解析模板: 缺少 xl/_rels/workbook.xml.rels')
  })
})
