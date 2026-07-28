import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ApiError, toErrorBody } from '~/platform/http/errors.ts'
import { validationHook } from '~/platform/http/zod.ts'

describe('统一错误模型', () => {
  test('ApiError 映射状态码与响应体', () => {
    expect(toErrorBody(new ApiError('unauthorized', '用户名或密码错误'))).toEqual({
      body: { error: { code: 'unauthorized', message: '用户名或密码错误' } },
      status: 401,
    })
    expect(toErrorBody(new ApiError('rate_limited', '稍后再试')).status).toBe(429)
    expect(toErrorBody(new ApiError('not_implemented', '未接入')).status).toBe(501)
  })

  test('validation 携带 fields', () => {
    const err = ApiError.validation('请求参数错误', { qty: ['必填'] })
    const { body, status } = toErrorBody(err)
    expect(status).toBe(400)
    expect(body.error.fields).toEqual({ qty: ['必填'] })
  })

  test('未知错误一律 500 不透出内部细节', () => {
    const { body, status } = toErrorBody(new Error('db connection leaked secret'))
    expect(status).toBe(500)
    expect(body.error.code).toBe('internal')
    expect(body.error.message).not.toContain('secret')
  })
})

describe('zod 校验钩子', () => {
  test('issues 聚合为 fields（点号路径）', () => {
    const schema = z.object({ username: z.string().min(1), nested: z.object({ qty: z.number() }) })
    const result = schema.safeParse({ username: '', nested: {} })
    expect(result.success).toBe(false)
    try {
      validationHook(result as never)
      expect.unreachable('应当抛出')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      const apiErr = err as ApiError
      expect(apiErr.code).toBe('validation')
      expect(Object.keys(apiErr.fields!)).toEqual(expect.arrayContaining(['username', 'nested.qty']))
    }
  })
})
