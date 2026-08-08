/**
 * 结构化日志（stdout/stderr JSON 行）。
 * 错误对象必须经 serializeError，避免 Error 被 console 打印成 `{}` 或丢 stack/cause。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 进程级最低日志级别：由入口在 loadEnv 后 setLogLevel(env.logLevel) 注入（默认 info）。
 * 语义约束：5xx 访问日志与错误落盘一律用 error 级别（见 app.ts accessLog / errors.ts），
 * 故即使 LOG_LEVEL=error，5xx 也始终可见，不会被过滤吞掉。
 */
let minLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

export function getLogLevel(): LogLevel {
  return minLevel
}

const MAX_CAUSE_DEPTH = 6

/** 将 unknown 错误展平为可 JSON 序列化的结构（含 stack、cause 链、常见 PG 字段） */
export function serializeError(err: unknown, depth = 0): unknown {
  if (err == null) return err
  if (typeof err !== 'object') return String(err)
  if (depth >= MAX_CAUSE_DEPTH) return { message: '[cause depth exceeded]' }

  const e = err as Error & Record<string, unknown>
  const out: Record<string, unknown> = {}

  if (typeof e.name === 'string' && e.name) out.name = e.name
  if (typeof e.message === 'string') out.message = e.message
  if (typeof e.stack === 'string' && e.stack) out.stack = e.stack

  // Postgres / Node 系统错误码
  if (e.code != null) out.code = e.code
  for (const key of ['detail', 'hint', 'severity', 'table', 'column', 'constraint', 'where', 'schema'] as const) {
    if (e[key] != null) out[key] = e[key]
  }

  // ApiError 等业务字段（避免循环引用直接展开整个 err）
  if ('fields' in e && e.fields != null && typeof e.fields === 'object') {
    out.fields = e.fields
  }

  if ('cause' in e && e.cause !== undefined) {
    out.cause = serializeError(e.cause, depth + 1)
  }

  // 非 Error 的纯对象：尽量保留可序列化键
  if (!(err instanceof Error) && Object.keys(out).length === 0) {
    try {
      return JSON.parse(JSON.stringify(err))
    } catch {
      return { message: Object.prototype.toString.call(err) }
    }
  }

  return out
}

export function logJson(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...extra,
  })
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}
