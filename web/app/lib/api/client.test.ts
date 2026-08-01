import { describe, expect, test } from 'bun:test'
import type { ApiErrorBody } from '@synie/shared'
import type { ClientResponse } from 'hono/client'
import { AppError } from '../errors'
import {
  APIError,
  api,
  apiData,
  readApiResponse,
  type ApiResponseAdapter,
  type ApiResponseData,
  type ApiSuccess,
} from './client'

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false
type Assert<TValue extends true> = TValue

type SyntheticResponse =
  | ClientResponse<{ id: string; name: string }, 200, 'json'>
  | ClientResponse<never, 204, 'json'>
  | ClientResponse<ApiErrorBody, 400, 'json'>
  | ClientResponse<ApiErrorBody, 409, 'json'>

type _SyntheticSuccessOnly = Assert<
  Equal<
    ApiResponseData<SyntheticResponse>,
    { id: string; name: string } | undefined
  >
>

type MeEndpoint = typeof api.auth.me.$get
type MeRequestResponse = Awaited<ReturnType<MeEndpoint>>
type _InferResponseMatchesClientResponse = Assert<
  Equal<ApiSuccess<MeEndpoint>, ApiResponseData<MeRequestResponse>>
>
function inferredMeRequest() {
  return apiData(api.auth.me.$get())
}
type _ApiDataUsesTypedOverload = Assert<
  Equal<
    Awaited<ReturnType<typeof inferredMeRequest>>,
    ApiSuccess<MeEndpoint>
  >
>

function fakeResponse(input: {
  status: number
  body?: unknown
  statusText?: string
  contentType?: string | null
  onText?: () => void
  rawBody?: string
}): ApiResponseAdapter {
  const hasBody = Object.hasOwn(input, 'body')
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    statusText: input.statusText ?? '',
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-type'
          ? (input.contentType === undefined
              ? 'application/json'
              : input.contentType)
          : null,
    },
    text: async () => {
      input.onText?.()
      if (input.rawBody !== undefined) return input.rawBody
      if (!hasBody) return ''
      return input.contentType === 'text/plain'
        ? String(input.body)
        : JSON.stringify(input.body)
    },
  }
}

describe('typed Hono response transport', () => {
  test('2xx JSON body 经最小 response interface 返回', async () => {
    await expect(
      readApiResponse(
        fakeResponse({ status: 200, body: { id: '1', name: '人民币' } }),
      ),
    ).resolves.toEqual({ id: '1', name: '人民币' })
  })

  test('204 不读取 body 并返回 undefined', async () => {
    let read = false
    const result = await readApiResponse(
      fakeResponse({
        status: 204,
        onText: () => {
          read = true
        },
      }),
    )
    expect(result).toBeUndefined()
    expect(read).toBeFalse()
  })

  test('非 JSON 成功 body 保留 string', async () => {
    await expect(
      readApiResponse(
        fakeResponse({
          status: 200,
          body: 'ready',
          contentType: 'text/plain',
        }),
      ),
    ).resolves.toBe('ready')
  })

  test('text/plain 空 body 保留空字符串', async () => {
    await expect(
      readApiResponse(
        fakeResponse({
          status: 200,
          body: '',
          contentType: 'text/plain',
        }),
      ),
    ).resolves.toBe('')
  })

  test('声明为 JSON 的 200 空 body 也视为 transport 契约错误', async () => {
    await expect(
      readApiResponse(
        fakeResponse({
          status: 200,
          rawBody: '',
          contentType: 'application/json',
        }),
      ),
    ).rejects.toBeInstanceOf(SyntaxError)
  })

  test('声明为 JSON 的畸形 body 直接拒绝，不把 string 冒充静态对象类型', async () => {
    await expect(
      readApiResponse(
        fakeResponse({
          status: 200,
          rawBody: '{broken',
          contentType: 'application/json',
        }),
      ),
    ).rejects.toBeInstanceOf(SyntaxError)
  })

  test('JSON content-type 大小写不敏感', async () => {
    await expect(
      readApiResponse(
        fakeResponse({
          status: 200,
          body: { ready: true },
          contentType: 'Application/JSON; Charset=UTF-8',
        }),
      ),
    ).resolves.toEqual({ ready: true })
  })

  test('项目 APIError envelope 保留 code、message、fields 与 status', async () => {
    const response = fakeResponse({
      status: 400,
      body: {
        error: {
          code: 'validation',
          message: '参数不合法',
          fields: { amount: ['必须大于零'] },
        },
      } satisfies ApiErrorBody,
    })

    try {
      await readApiResponse(response)
      throw new Error('expected APIError')
    } catch (error) {
      expect(error).toBeInstanceOf(APIError)
      expect(error).toMatchObject({
        code: 'validation',
        message: '参数不合法',
        fields: { amount: ['必须大于零'] },
        status: 400,
      })
    }
  })

  test('缺少 content-type 时仍识别项目 JSON 错误 envelope', async () => {
    await expect(
      readApiResponse(
        fakeResponse({
          status: 409,
          contentType: null,
          body: {
            error: {
              code: 'conflict',
              message: '记录已被修改',
            },
          } satisfies ApiErrorBody,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: '记录已被修改',
      status: 409,
    })
  })

  test('非 envelope 错误仍沿用 AppError http_error 语义', async () => {
    const promise = readApiResponse(
      fakeResponse({
        status: 502,
        statusText: 'Bad Gateway',
        body: '<html />',
        contentType: 'text/html',
      }),
    )
    await expect(promise).rejects.toBeInstanceOf(AppError)
    await expect(promise).rejects.toMatchObject({ codes: ['http_error'] })
  })

  test('畸形 error 字段不会被强转成项目 APIError', async () => {
    const promise = readApiResponse(
      fakeResponse({
        status: 502,
        statusText: 'Bad Gateway',
        body: { error: 'gateway' },
      }),
    )
    await expect(promise).rejects.toBeInstanceOf(AppError)
    await expect(promise).rejects.not.toBeInstanceOf(APIError)
    await expect(promise).rejects.toMatchObject({ codes: ['http_error'] })
  })
})
