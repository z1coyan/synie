import { describe, expect, test } from 'bun:test'
import { normalizeGlLines } from './model'

const accountId = 'account' as never
const valid = () => [
  { accountId, debit: '10' },
  { accountId, credit: '10' },
]

describe('GL validateShape 旧行为 oracle', () => {
  test('合法两行借贷配平通过', () => expect(normalizeGlLines(valid())).toHaveLength(2))
  test('不足两行拒绝', () => expect(() => normalizeGlLines([{ accountId, debit: '10' }])).toThrow('总账过账校验失败'))
  test('双边为零拒绝', () => expect(() => normalizeGlLines([{ accountId }, { accountId }])).toThrow('总账过账校验失败'))
  test('同一行借贷均非零拒绝', () => expect(() => normalizeGlLines([{ accountId, debit: '1', credit: '1' }, { accountId, credit: '1' }])).toThrow('总账过账校验失败'))
  test('借贷不平拒绝（容差 0）', () => expect(() => normalizeGlLines([{ accountId, debit: '2' }, { accountId, credit: '1' }])).toThrow('总账过账校验失败'))
  test('对手类型与 ID 必须成对', () => expect(() => normalizeGlLines([{ accountId, debit: '10', partyType: 'customer' }, { accountId, credit: '10' }])).toThrow('总账过账校验失败'))
  test('普通过账拒绝负数；红冲允许负数', () => {
    const red = [{ accountId, debit: '-10' }, { accountId, credit: '-10' }]
    expect(() => normalizeGlLines(red)).toThrow('总账过账校验失败')
    expect(normalizeGlLines(red, true)).toHaveLength(2)
  })
  test('十进制字符串精确配平（无 number 精度漂移）', () => expect(normalizeGlLines([
    { accountId, debit: '0.1' },
    { accountId, debit: '0.2' },
    { accountId, credit: '0.3' },
  ])).toHaveLength(3))
})
