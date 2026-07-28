import { decimal, toDecimalString } from '@synie/shared'

/**
 * 考勤日算与 .dat 解析纯函数（对齐 server-go/internal/domain/hr/operations）。
 * ADR: docs/adr/2026-07-15-attendance-daily-calc.md / attendance-import.md
 */

export const MORNING_AFTERNOON_SPLIT_HOUR = 12
export const SEGMENT_ROUND_MS = 30 * 60 * 1000
export const HALF_DAY_UNITS = 8
export const BONUS_THRESHOLD_UNITS = 7
export const FULL_DAY_HOURS = 8
export const FULL_DAY_HOURS_SQL = '8'
/** 导入/日切固定 UTC+8，不引 tzdata */
export const ATTENDANCE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
export const ATTENDANCE_OFFSET_INTERVAL = '8 hours'
export const MAX_IMPORT_ROWS = 100_000
export const BONUS_WORKDAY = decimal('0.5')

export const IMPORT_PARSED = 'parsed'
export const IMPORT_FAILED = 'failed'
export const IMPORT_IMPORTED = 'imported'
export const DAY_OK = 'ok'
export const DAY_MISSING = 'missing'
export const PAYROLL_PENDING = 'pending'
export const PAYROLL_PAID = 'paid'
export const PAYMENT_NORMAL = 'normal'
export const PAYMENT_SUPPLEMENT = 'supplement'
export const LOAN_BORROW = 'borrow'
export const LOAN_REPAY = 'repay'

export interface ParsedPunch {
  attendanceNo: string
  punchedAt: Date
}

export interface ParsedFile {
  rows: ParsedPunch[]
  totalRows: number
  badRows: number
  dupRows: number
}

export interface ComputedDay {
  morningIn: string | null
  morningOut: string | null
  afternoonIn: string | null
  afternoonOut: string | null
  normalHours: string
  overtimeHours: string
  bonusWorkday: string
  status: typeof DAY_OK | typeof DAY_MISSING
}

export function parseAttendanceFile(value: Uint8Array | string): ParsedFile {
  const text =
    typeof value === 'string'
      ? value
      : new TextDecoder('utf-8', { fatal: false }).decode(value)
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const nonblank = raw.split('\n').filter((line) => line.trim() !== '')
  const total = nonblank.length
  if (total === 0) throw new Error('文件为空,未解析到打卡行')
  if (total > MAX_IMPORT_ROWS) {
    throw new Error(`文件超过 ${MAX_IMPORT_ROWS} 行上限,请拆分后导入`)
  }
  const result: ParsedFile = { rows: [], totalRows: total, badRows: 0, dupRows: 0 }
  const seen = new Set<string>()
  for (const line of nonblank) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3 || !fields[0] || fields[0].length < 1 || fields[0].length > 64) {
      result.badRows++
      continue
    }
    const localMs = Date.parse(`${fields[1]}T${fields[2]}Z`)
    if (Number.isNaN(localMs)) {
      result.badRows++
      continue
    }
    // 本地墙钟按 UTC 解析后减固定偏移 → 存储 UTC 瞬时
    const punchedAt = new Date(localMs - ATTENDANCE_UTC_OFFSET_MS)
    const key = `${fields[0]}\0${punchedAt.toISOString()}`
    if (seen.has(key)) {
      result.dupRows++
      continue
    }
    seen.add(key)
    result.rows.push({ attendanceNo: fields[0], punchedAt })
  }
  if (result.rows.length === 0) {
    throw new Error(`未解析到有效打卡行(共 ${total} 行均无法识别)`)
  }
  return result
}

export function unmatchedDetail(
  rows: ParsedPunch[],
  matched: ReadonlyMap<string, string>,
): string | null {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!matched.has(row.attendanceNo)) {
      counts.set(row.attendanceNo, (counts.get(row.attendanceNo) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return null
  const keys = [...counts.keys()].sort()
  const total = keys.length
  const shown = keys.slice(0, 50)
  let value = shown.map((key) => `${key}×${counts.get(key)}`).join('、')
  if (total > 50) value += `……(等共 ${total} 个编号)`
  if (value.length > 2000) value = value.slice(0, 2000)
  return value
}

export function computeAttendanceDay(raw: string[]): ComputedDay {
  const morning: number[] = []
  const afternoon: number[] = []
  for (const value of raw) {
    const parts = value.split(':').map(Number)
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      throw new Error(`解析日考勤时刻失败: ${value}`)
    }
    const [h = 0, m = 0, s = 0] = parts
    const ms = ((h * 60 + m) * 60 + s) * 1000
    if (h < MORNING_AFTERNOON_SPLIT_HOUR) morning.push(ms)
    else afternoon.push(ms)
  }
  morning.sort((a, b) => a - b)
  afternoon.sort((a, b) => a - b)
  const [mIn, mOut] = timeBounds(morning)
  const [aIn, aOut] = timeBounds(afternoon)
  const mUnits = Math.min(spanUnits(morning), HALF_DAY_UNITS)
  const aUnits = spanUnits(afternoon)
  const otUnits = Math.max(aUnits - HALF_DAY_UNITS, 0)
  const normal = decimal(mUnits + Math.min(aUnits, HALF_DAY_UNITS)).div(2)
  const overtime = decimal(otUnits).div(2)
  const bonus = otUnits >= BONUS_THRESHOLD_UNITS ? BONUS_WORKDAY : decimal(0)
  const status =
    morning.length === 1 || afternoon.length === 1 ? DAY_MISSING : DAY_OK
  return {
    morningIn: mIn,
    morningOut: mOut,
    afternoonIn: aIn,
    afternoonOut: aOut,
    normalHours: toDecimalString(normal),
    overtimeHours: toDecimalString(overtime),
    bonusWorkday: toDecimalString(bonus),
    status,
  }
}

function timeBounds(values: number[]): [string | null, string | null] {
  if (values.length === 0) return [null, null]
  const first = values[0]!
  const last = values[values.length - 1]!
  return [formatTime(first), formatTime(last)]
}

function spanUnits(values: number[]): number {
  if (values.length < 2) return 0
  return Math.floor((values[values.length - 1]! - values[0]!) / SEGMENT_ROUND_MS)
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** punched_at(UTC) → 本地自然日 YYYY-MM-DD */
export function localDate(value: Date): string {
  return new Date(value.getTime() + ATTENDANCE_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

export function upperWire(value: string): string {
  return value.toUpperCase()
}

export function lowerWire(value: string): string {
  return value.toLowerCase()
}

// ── 工资发放 ↔ 借款抵扣纯核 ─────────────────────────────────────────────────
// IO（写 payment / loan / payroll status / audit）归 service adapter。
// 产品规则：docs/产品文档/人力薪酬.md「工资发放与借款抵扣」

/** 参与余额汇总的借款台账行（kind 大小写不敏感） */
export interface LoanBalanceRow {
  kind: string
  amount: string
}

export interface ApplyPaymentPayroll {
  id: string
  employeeId: string
  /** wire 大写：PENDING / PAID */
  status: string
  loanDeduction: string
}

export type PaymentEffect =
  | { op: 'set_payroll_status'; status: typeof PAYROLL_PAID | typeof PAYROLL_PENDING }
  | { op: 'create_auto_repay'; amount: string }
  | { op: 'destroy_linked_loans' }

export interface ApplyPaymentPlan {
  kind: typeof PAYMENT_NORMAL | typeof PAYMENT_SUPPLEMENT
  effects: PaymentEffect[]
}

/** 余额 = Σ借款 − Σ归还（员工级） */
export function loanBalance(loans: readonly LoanBalanceRow[]): ReturnType<typeof decimal> {
  let bal = decimal(0)
  for (const row of loans) {
    const k = lowerWire(row.kind)
    const amt = decimal(row.amount)
    if (k === LOAN_BORROW) bal = bal.add(amt)
    else bal = bal.sub(amt)
  }
  return bal
}

/**
 * 首笔/补发决策 + 借款联动 effects。
 * - 待发放 → normal；否则 supplement
 * - normal 且借款抵扣 > 0：校验余额 ≥ 抵扣，产出 auto_repay
 * - normal：产出 set_payroll_status(paid)
 */
export function applyPayment(
  payroll: ApplyPaymentPayroll,
  loans: readonly LoanBalanceRow[],
): ApplyPaymentPlan {
  const isPending = upperWire(payroll.status) === upperWire(PAYROLL_PENDING)
  if (!isPending) {
    return { kind: PAYMENT_SUPPLEMENT, effects: [] }
  }
  const effects: PaymentEffect[] = [
    { op: 'set_payroll_status', status: PAYROLL_PAID },
  ]
  const deduction = decimal(payroll.loanDeduction)
  if (deduction.gt(0)) {
    const bal = loanBalance(loans)
    if (bal.lessThan(deduction)) {
      throw new Error('借款抵扣超过员工借款余额')
    }
    effects.push({ op: 'create_auto_repay', amount: toDecimalString(deduction) })
  }
  return { kind: PAYMENT_NORMAL, effects }
}

/**
 * 删除发放时的回滚决策。
 * - 删 normal，或删后无剩余发放：若已发放则 mark pending，并 destroy 联动归还
 * - 仅删 supplement 且仍有其他发放：无联动
 */
export function reversePayment(
  paymentKind: string,
  payrollStatus: string,
  remainingPaymentCount: number,
): PaymentEffect[] {
  const isNormal = upperWire(paymentKind) === upperWire(PAYMENT_NORMAL)
  if (!isNormal && remainingPaymentCount > 0) return []
  const effects: PaymentEffect[] = []
  if (upperWire(payrollStatus) === upperWire(PAYROLL_PAID)) {
    effects.push({ op: 'set_payroll_status', status: PAYROLL_PENDING })
  }
  effects.push({ op: 'destroy_linked_loans' })
  return effects
}
