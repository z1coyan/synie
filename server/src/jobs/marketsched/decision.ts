/**
 * 进程内行情定时调度决策（纯函数）。
 * 语义对齐 server-go/internal/jobs/marketsched：
 * - 定时总开关关 → 不跑
 * - 最新价：交易时段内按间隔(30/60/120，非法按 60)对齐槽位
 * - 结算：配置允许时，工作日 15:30/16:00/16:30/17:00（上海）尝试补拉
 * 上海时区固定 UTC+8，无夏令时。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface MarketScheduleConfig {
  scheduleEnabled: boolean
  lastIntervalMinutes: number
  settlementEnabled: boolean
}

export interface SlotKey {
  /** 上海日历日 YYYY-MM-DD */
  date: string
  /** 当日分钟数（最新价为槽起点，结算为尝试时刻） */
  slot: number
}

export interface ScheduleState {
  lasts: SlotKey | null
  settlement: SlotKey | null
}

export interface ScheduleDecision {
  runLasts: boolean
  runSettlements: boolean
  next: ScheduleState
}

export function emptyScheduleState(): ScheduleState {
  return { lasts: null, settlement: null }
}

/** 纯函数：给定配置、当前 UTC 时刻与上次状态，判定本节拍是否触发拉取 */
export function decide(
  cfg: MarketScheduleConfig,
  now: Date,
  prev: ScheduleState,
): ScheduleDecision {
  const decision: ScheduleDecision = {
    runLasts: false,
    runSettlements: false,
    next: { lasts: prev.lasts, settlement: prev.settlement },
  }
  if (!cfg.scheduleEnabled) return decision

  const sh = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const mins = sh.getUTCHours() * 60 + sh.getUTCMinutes()
  const date = formatShanghaiDate(sh)

  const interval = normalizeInterval(cfg.lastIntervalMinutes)
  const slotStart = Math.floor(mins / interval) * interval
  if (mins - slotStart <= 1 && inLastSession(mins)) {
    const key: SlotKey = { date, slot: slotStart }
    if (!slotEqual(prev.lasts, key)) {
      decision.runLasts = true
      decision.next.lasts = key
    }
  }

  if (cfg.settlementEnabled && isWeekday(sh)) {
    const slot = settlementSlot(mins)
    if (slot !== null) {
      const key: SlotKey = { date, slot }
      if (!slotEqual(prev.settlement, key)) {
        decision.runSettlements = true
        decision.next.settlement = key
      }
    }
  }
  return decision
}

export function normalizeInterval(n: number): number {
  switch (n) {
    case 30:
    case 60:
    case 120:
      return n
    default:
      return 60
  }
}

/** 日盘 09:00–15:05，夜盘 21:00–次日 02:35 */
export function inLastSession(mins: number): boolean {
  const day = mins >= 9 * 60 && mins < 15 * 60 + 5
  const night = mins >= 21 * 60 || mins < 2 * 60 + 35
  return day || night
}

function isWeekday(sh: Date): boolean {
  // getUTCDay：上海墙钟已通过 +8 偏移写在 UTC 字段上
  const weekday = sh.getUTCDay()
  return weekday !== 0 && weekday !== 6
}

/** 结算尝试槽 15:30/16:00/16:30/17:00，槽后 1 分钟内也视为到达 */
export function settlementSlot(mins: number): number | null {
  for (const slot of [15 * 60 + 30, 16 * 60, 16 * 60 + 30, 17 * 60]) {
    if (mins >= slot && mins <= slot + 1) return slot
  }
  return null
}

function formatShanghaiDate(sh: Date): string {
  const y = sh.getUTCFullYear()
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0')
  const d = String(sh.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function slotEqual(a: SlotKey | null, b: SlotKey): boolean {
  return a !== null && a.date === b.date && a.slot === b.slot
}
