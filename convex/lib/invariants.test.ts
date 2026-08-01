import { describe, expect, test } from 'bun:test'
import { ConvexError } from 'convex/values'
import {
  assertCheck,
  assertDeleteAllowed,
  assertEnum,
  assertExists,
  assertRange,
  assertUniqueByIndex,
} from './invariants'

describe('domain invariant guards', () => {
  test('存在、唯一与删除保护使用稳定错误 envelope', () => {
    expect(assertExists('ok', '记录')).toBe('ok')
    for (const invoke of [
      () => assertExists(null, '记录'),
      () => assertUniqueByIndex({}, '编码'),
      () => assertDeleteAllowed(true, '仍被引用'),
    ]) {
      expect(invoke).toThrow(ConvexError)
    }
  })

  test('enum/range/check fail-closed', () => {
    expect(() => assertEnum('bad', ['good'] as const, 'kind')).toThrow()
    expect(() => assertRange(11n, { min: 0n, max: 10n, field: 'qty' })).toThrow()
    expect(() => assertCheck(false, 'parentId', '不能形成环')).toThrow()
  })
})
