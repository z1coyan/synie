import { describe, expect, test } from 'bun:test'
import { NUMBERING_CATALOG } from './catalog'
import { renderDate, renderNumber, validateSegments } from './model'

describe('numbering model', () => {
  test('sealed Catalog、日期和补零格式', () => {
    const fields = NUMBERING_CATALOG['engine.document'].fields
    expect(() => validateSegments([
      { kind: 'text', value: 'IV' },
      { kind: 'field', field: 'posting_date', format: 'YYYYMM' },
      { kind: 'sequence', padding: 4 },
    ], fields)).not.toThrow()
    expect(renderDate('2026-07-31', 'YYMMDD')).toBe('260731')
    expect(renderNumber([{ text: 'IV' }, { sequence: true, padding: 4 }], 12n)).toBe('IV0012')
  })

  test('必须恰好一个 sequence 且 field 必须来自 Catalog', () => {
    const fields = NUMBERING_CATALOG['engine.document'].fields
    expect(() => validateSegments([{ kind: 'text', value: 'IV' }], fields)).toThrow('序号段必须恰好一个')
    expect(() => validateSegments([
      { kind: 'field', field: 'raw.sql' },
      { kind: 'sequence', padding: 4 },
    ], fields)).toThrow('在绑定资源上不存在')
  })
})
