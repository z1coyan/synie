import { describe, expect, test } from 'bun:test'
import { amountInWords, formatAmount, formatQty } from './amount'

describe('formatAmount', () => {
  test('千分位两位小数', () => expect(formatAmount(1234567.8)).toBe('1,234,567.80'))
  test('空值', () => expect(formatAmount(null)).toBe(''))
})

describe('formatQty', () => {
  test('decimal 字符串去尾零', () => expect(formatQty('200.000000')).toBe('200'))
  test('千分位', () => expect(formatQty('12345.500000')).toBe('12,345.5'))
  test('6 位精度保留', () => expect(formatQty('0.000001')).toBe('0.000001'))
  test('超长小数截断到 6 位', () => expect(formatQty(1 / 3)).toBe('0.333333'))
  test('窄空间 4 位', () => expect(formatQty(1 / 3, 4)).toBe('0.3333'))
  test('空值', () => expect(formatQty(null)).toBe(''))
  test('非数值原样', () => expect(formatQty('abc')).toBe('abc'))
})

describe('amountInWords', () => {
  test('零', () => expect(amountInWords(0)).toBe('零元整'))
  test('整数', () => expect(amountInWords(10)).toBe('壹拾元整'))
  test('角分', () => expect(amountInWords(1234.56)).toBe('壹仟贰佰叁拾肆元伍角陆分'))
  test('只有分补零', () => expect(amountInWords(105.05)).toBe('壹佰零伍元零伍分'))
  test('纯分', () => expect(amountInWords(0.05)).toBe('伍分'))
  test('跨组补零', () => expect(amountInWords(100200)).toBe('壹拾万零贰佰元整'))
  test('中段整组为零', () => expect(amountInWords(100000200)).toBe('壹亿零贰佰元整'))
  test('亿', () => expect(amountInWords(100000000)).toBe('壹亿元整'))
  test('负数', () => expect(amountInWords(-3.2)).toBe('负叁元贰角'))

  // 边界测试
  test('百万整数', () => expect(amountInWords(1000000)).toBe('壹佰万元整'))
  test('单个元整', () => expect(amountInWords(8.00)).toBe('捌元整'))
  test('纯角', () => expect(amountInWords(0.5)).toBe('伍角'))
  test('千万复杂', () => expect(amountInWords(10000005.05)).toBe('壹仟万零伍元零伍分'))
  test('小数点精度', () => expect(amountInWords(99.99)).toBe('玖拾玖元玖角玖分'))
})
