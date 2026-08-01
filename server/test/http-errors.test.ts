import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { ApiError, onError, toErrorBody } from '~/platform/http/errors.ts'
import { serializeError } from '~/platform/http/log.ts'
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

describe('serializeError', () => {
  test('展开 stack 与 cause 链', () => {
    const root = new Error('root-cause')
    const mid = new Error('mid', { cause: root })
    const top = new ApiError('internal', '创建失败', { cause: mid })
    const ser = serializeError(top) as Record<string, unknown>
    expect(ser.name).toBe('ApiError')
    expect(ser.message).toBe('创建失败')
    expect(typeof ser.stack).toBe('string')
    const cause = ser.cause as Record<string, unknown>
    expect(cause.message).toBe('mid')
    const nested = cause.cause as Record<string, unknown>
    expect(nested.message).toBe('root-cause')
  })
})

describe('onError 错误日志', () => {
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

  afterEach(() => {
    errorSpy.mockClear()
  })

  test('5xx 必须 error 落盘且含序列化 error', async () => {
    const app = new Hono()
    app.onError(onError)
    app.get('/boom', () => {
      throw new Error('secret-db-leak')
    })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(errorSpy).toHaveBeenCalled()
    const line = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('"msg":"http_error"')
    expect(line).toContain('"level":"error"')
    expect(line).toContain('secret-db-leak')
    expect(line).toContain('"stack"')
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).not.toContain('secret')
  })

  test('4xx 不打 error 日志', async () => {
    const app = new Hono()
    app.onError(onError)
    app.get('/nope', () => {
      throw new ApiError('not_found', '不存在')
    })
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(errorSpy).not.toHaveBeenCalled()
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
