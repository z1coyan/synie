import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/platform/http/errors.ts'
import { validateShapeForTest } from './engine.ts'
import type { GlEntry } from './types.ts'

const accountId = crypto.randomUUID()

function entriesMsg(err: unknown): string {
  expect(err).toBeInstanceOf(ApiError)
  const e = err as ApiError
  expect(e.code).toBe('validation')
  expect(e.message).toBe('总账过账校验失败')
  return e.fields?.entries?.[0] ?? ''
}

describe('GL validateShape', () => {
  test('合法两行借贷配平通过', () => {
    const valid: GlEntry[] = [
      { accountId, debit: '10' },
      { accountId, credit: '10' },
    ]
    expect(() => validateShapeForTest(valid)).not.toThrow()
  })

  test('不足两行拒绝', () => {
    try {
      validateShapeForTest([{ accountId, debit: '10' }])
      expect.unreachable()
    } catch (err) {
      expect(entriesMsg(err)).toBe('分录不少于两行')
    }
  })

  test('双边为零拒绝', () => {
    try {
      validateShapeForTest([{ accountId }, { accountId }])
      expect.unreachable()
    } catch (err) {
      expect(entriesMsg(err)).toBe('每行借贷必须恰一边大于零')
    }
  })

  test('同一行借贷均非零拒绝', () => {
    try {
      validateShapeForTest([
        { accountId, debit: '1', credit: '1' },
        { accountId, credit: '1' },
      ])
      expect.unreachable()
    } catch (err) {
      expect(entriesMsg(err)).toBe('每行借贷必须恰一边大于零')
    }
  })

  test('借贷不平拒绝（容差 0）', () => {
    try {
      validateShapeForTest([
        { accountId, debit: '2' },
        { accountId, credit: '1' },
      ])
      expect.unreachable()
    } catch (err) {
      expect(entriesMsg(err)).toBe('借贷不平')
    }
  })

  test('对手类型与 ID 必须成对', () => {
    try {
      validateShapeForTest([
        { accountId, debit: '10', partyType: 'customer' },
        { accountId, credit: '10' },
      ])
      expect.unreachable()
    } catch (err) {
      expect(entriesMsg(err)).toBe('对手类型与对手必须同时填写')
    }
  })

  test('普通过账拒绝负数；红冲允许负数', () => {
    const red: GlEntry[] = [
      { accountId, debit: '-10', isReversal: true },
      { accountId, credit: '-10', isReversal: true },
    ]
    try {
      validateShapeForTest(red, false)
      expect.unreachable()
    } catch (err) {
      expect(entriesMsg(err)).toBe('每行借贷必须恰一边大于零')
    }
    expect(() => validateShapeForTest(red, true)).not.toThrow()
  })

  test('十进制字符串精确配平（无 number 精度漂移）', () => {
    expect(() =>
      validateShapeForTest([
        { accountId, debit: '0.1' },
        { accountId, debit: '0.2' },
        { accountId, credit: '0.3' },
      ]),
    ).not.toThrow()
  })
})
