import { logJson } from './log.ts'

/**
 * 5xx 错误上报（通用 webhook，env ERROR_REPORT_WEBHOOK_URL 配置；不配则不启用，零行为变化）。
 * 只外发摘要（requestId/method/path/status/errorCode/错误摘要/ts），不带堆栈全文，
 * 防止内部细节外泄；排障细节留在本地日志，按 requestId 关联。
 */

/** 上报 webhook 的 5xx 摘要载荷 */
export interface ErrorReportSummary {
  requestId?: string
  method: string
  path: string
  status: number
  errorCode: string
  /** 错误摘要（ApiError 为 name: message；未知错误仅类型名；已截断） */
  error: string
  ts: string
  /** 距上一条上报之间被限频吞掉的条数（>0 才带） */
  suppressed?: number
}

export interface ErrorReporter {
  /** fire-and-forget：内部异步、自带兜底，绝不抛错、不影响请求链路 */
  report(summary: ErrorReportSummary): void
}

export interface WebhookErrorReporterDeps {
  url: string
  /** 可注入 fetch（测试）；默认全局 fetch */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** 单次上报超时（毫秒），默认 3000 */
  timeoutMs?: number
  /** 限频：两条上报的最小间隔（毫秒），默认 1000；间隔内的上报计数合并进下一条 */
  minIntervalMs?: number
  /** 可注入时钟（测试）；默认 Date.now */
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_MIN_INTERVAL_MS = 1_000

export function createWebhookErrorReporter(deps: WebhookErrorReporterDeps): ErrorReporter {
  const fetchFn = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const nowFn = deps.now ?? Date.now
  let lastSentAt = Number.NEGATIVE_INFINITY
  let suppressed = 0

  async function send(payload: ErrorReportSummary): Promise<void> {
    try {
      const res = await fetchFn(deps.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        logJson('warn', 'error_report_webhook_failed', { httpStatus: res.status })
      }
    } catch (err) {
      // 兜底：上报失败（网络/超时）只落 warn 日志，绝不再炸请求链路
      logJson('warn', 'error_report_webhook_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    report(summary) {
      const now = nowFn()
      if (now - lastSentAt < minIntervalMs) {
        suppressed += 1
        return
      }
      lastSentAt = now
      const payload = suppressed > 0 ? { ...summary, suppressed } : summary
      suppressed = 0
      void send(payload)
    },
  }
}
