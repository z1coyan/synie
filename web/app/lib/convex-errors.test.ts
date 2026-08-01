import { describe, expect, test } from 'bun:test'
import {
  ConvexAppError,
  SYNIE_ERROR_CODES,
  mapConvexError,
} from './convex-errors'

describe('Convex error mapper', () => {
  for (const code of SYNIE_ERROR_CODES) {
    test(`保留 ${code} envelope`, () => {
      const mapped = mapConvexError({
        data: {
          code,
          message: `message:${code}`,
          fields: { username: ['invalid'] },
        },
      })
      expect(mapped).toBeInstanceOf(ConvexAppError)
      expect(mapped.code).toBe(code)
      expect(mapped.fields).toEqual({ username: ['invalid'] })
      expect(mapped.message).toBe(
        code === 'forbidden'
          ? '无权限访问,请联系管理员分配权限'
          : `message:${code}`,
      )
    })
  }

  test('未知异常不泄漏原 message 或 stack', () => {
    const mapped = mapConvexError(new Error('SECRET_INTERNAL_DETAIL'))
    expect(mapped.code).toBe('internal')
    expect(mapped.message).toBe('请求失败,请稍后再试')
    expect(mapped.message).not.toContain('SECRET_INTERNAL_DETAIL')
  })
})
