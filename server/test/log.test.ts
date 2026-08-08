import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { getLogLevel, logJson, setLogLevel, type LogLevel } from '~/platform/http/log.ts'

/** 各级别下应可见的级别（5xx 语义依赖 error 恒可见） */
const VISIBILITY: Record<LogLevel, LogLevel[]> = {
  debug: ['debug', 'info', 'warn', 'error'],
  info: ['info', 'warn', 'error'],
  warn: ['warn', 'error'],
  error: ['error'],
}

describe('LOG_LEVEL 级别过滤', () => {
  const logSpy = spyOn(console, 'log').mockImplementation(() => {})
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

  afterEach(() => {
    setLogLevel('info')
    logSpy.mockClear()
    warnSpy.mockClear()
    errorSpy.mockClear()
  })

  test('默认级别为 info', () => {
    expect(getLogLevel()).toBe('info')
  })

  for (const [min, visible] of Object.entries(VISIBILITY) as [LogLevel, LogLevel[]][]) {
    test(`LOG_LEVEL=${min}：只见 ${visible.join('/')}`, () => {
      setLogLevel(min)
      for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) {
        logJson(level, `msg-${level}`)
      }
      for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) {
        const spy = level === 'error' ? errorSpy : level === 'warn' ? warnSpy : logSpy
        const hit = spy.mock.calls.some((call) => String(call[0]).includes(`msg-${level}`))
        expect({ level, hit }).toEqual({ level, hit: visible.includes(level) })
      }
    })
  }

  test('被过滤的级别完全不产生输出', () => {
    setLogLevel('error')
    logJson('debug', 'x')
    logJson('info', 'x')
    logJson('warn', 'x')
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('error 级别下 error 仍落盘（5xx 可见性语义）', () => {
    setLogLevel('error')
    logJson('error', 'http_request', { status: 500 })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(errorSpy.mock.calls[0]![0])) as Record<string, unknown>
    expect(line.level).toBe('error')
    expect(line.status).toBe(500)
    expect(typeof line.ts).toBe('string')
  })
})
