import { describe, expect, test } from 'bun:test'
import { nextBoxNo } from './box-no'

describe('nextBoxNo(新增装箱行默认箱号:尾数 +1)', () => {
  test('保留前缀与补零宽度', () => {
    expect(nextBoxNo('A-01')).toBe('A-02')
    expect(nextBoxNo('A-09')).toBe('A-10')
    expect(nextBoxNo('箱3')).toBe('箱4')
    expect(nextBoxNo('1')).toBe('2')
  })

  test('位数自然增长不截断', () => {
    expect(nextBoxNo('A-99')).toBe('A-100')
    expect(nextBoxNo('99')).toBe('100')
  })

  test('尾无数字追加 -01;空串兜底 1', () => {
    expect(nextBoxNo('托盘甲')).toBe('托盘甲-01')
    expect(nextBoxNo('')).toBe('1')
    expect(nextBoxNo('  ')).toBe('1')
  })

  test('大数不丢精度(超 Number.MAX_SAFE_INTEGER 的编号)', () => {
    expect(nextBoxNo('X9007199254740993')).toBe('X9007199254740994')
  })
})
