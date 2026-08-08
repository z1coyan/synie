/**
 * 文件存储对账调度决策（纯函数）。
 * 形态对齐 jobs/marketsched：每日一次，上海时区固定 UTC+8（无夏令时）。
 * 到达每日运行时刻后、当日未跑过即触发；进程停机错过时刻时，重启后当日补跑一次。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface FileCleanConfig {
  enabled: boolean
  /** 上海时区每日运行时刻（小时，0-23） */
  runHour: number
}

export interface FileCleanState {
  /** 上次运行的上海日历日 YYYY-MM-DD；从未跑过为 null */
  lastRunDate: string | null
}

export interface FileCleanDecision {
  shouldRun: boolean
  /** 当前上海日历日 YYYY-MM-DD */
  today: string
  next: FileCleanState
}

export function emptyFileCleanState(): FileCleanState {
  return { lastRunDate: null }
}

/** 纯函数：给定配置、当前 UTC 时刻与上次状态，判定本节拍是否触发对账 */
export function decideFileClean(
  cfg: FileCleanConfig,
  now: Date,
  prev: FileCleanState,
): FileCleanDecision {
  const sh = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const today = formatShanghaiDate(sh)
  const decision: FileCleanDecision = { shouldRun: false, today, next: { lastRunDate: prev.lastRunDate } }
  if (!cfg.enabled) return decision
  if (sh.getUTCHours() < cfg.runHour) return decision
  if (prev.lastRunDate === today) return decision
  decision.shouldRun = true
  decision.next.lastRunDate = today
  return decision
}

function formatShanghaiDate(sh: Date): string {
  const y = sh.getUTCFullYear()
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0')
  const d = String(sh.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
