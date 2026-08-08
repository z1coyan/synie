import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  createWebhookErrorReporter,
  type ErrorReportSummary,
} from '~/platform/http/error-report.ts'

interface CapturedCall {
  url: string
  payload: ErrorReportSummary
  signal: AbortSignal | null
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

function fakeFetchOk(captured: CapturedCall[]): FetchFn {
  return async (url, init) => {
    captured.push({
      url,
      payload: JSON.parse(String(init.body)) as ErrorReportSummary,
      signal: init.signal ?? null,
    })
    return new Response('ok', { status: 200 })
  }
}

function sampleSummary(): ErrorReportSummary {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/api/v1/trading/sales-orders',
    status: 500,
    errorCode: 'internal',
    error: 'Error',
    ts: '2026-08-08T00:00:00.000Z',
  }
}

/** 等 fire-and-forget 的 send 跑完 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('webhook 5xx 上报 adapter', () => {
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
  })

  test('POST JSON 摘要到配置的 URL，带超时 signal', async () => {
    const captured: CapturedCall[] = []
    const reporter = createWebhookErrorReporter({
      url: 'https://hooks.example.com/synie',
      fetch: fakeFetchOk(captured),
    })
    reporter.report(sampleSummary())
    await flush()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe('https://hooks.example.com/synie')
    expect(captured[0]!.payload).toEqual(sampleSummary())
    expect(captured[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('fetch 抛错：不抛出、落 warn 兜底', async () => {
    const reporter = createWebhookErrorReporter({
      url: 'https://hooks.example.com/synie',
      fetch: (async () => {
        throw new Error('网络不可达')
      })
    })
    expect(() => reporter.report(sampleSummary())).not.toThrow()
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = String(warnSpy.mock.calls[0]![0])
    expect(line).toContain('error_report_webhook_failed')
    expect(line).toContain('网络不可达')
  })

  test('webhook 返回非 2xx：落 warn 兜底', async () => {
    const reporter = createWebhookErrorReporter({
      url: 'https://hooks.example.com/synie',
      fetch: (async () => new Response('bad', { status: 502 }))
    })
    reporter.report(sampleSummary())
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('"httpStatus":502')
  })

  test('超时中断：signal abort 后按失败兜底', async () => {
    const reporter = createWebhookErrorReporter({
      url: 'https://hooks.example.com/synie',
      timeoutMs: 5,
      fetch: (( _url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out', 'TimeoutError')),
          )
        }))
    })
    reporter.report(sampleSummary())
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('error_report_webhook_failed')
  })

  test('限频：最小间隔内的上报被吞并计数进下一条', async () => {
    const captured: CapturedCall[] = []
    let now = 1_000_000
    const reporter = createWebhookErrorReporter({
      url: 'https://hooks.example.com/synie',
      fetch: fakeFetchOk(captured),
      minIntervalMs: 1_000,
      now: () => now,
    })
    reporter.report(sampleSummary())
    reporter.report({ ...sampleSummary(), requestId: 'req-2' })
    reporter.report({ ...sampleSummary(), requestId: 'req-3' })
    await flush()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.payload.requestId).toBe('req-1')

    now += 1_001
    reporter.report({ ...sampleSummary(), requestId: 'req-4' })
    await flush()
    expect(captured).toHaveLength(2)
    expect(captured[1]!.payload.requestId).toBe('req-4')
    expect(captured[1]!.payload.suppressed).toBe(2)
  })
})
