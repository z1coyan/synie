import {
  decimal,
  isDecimalString,
  roundAmount,
  toDecimalString,
  type ListQuery,
} from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { hasPermission, requirePermission, type Actor } from '~/platform/authz/actor.ts'
import type { FileService } from '~/platform/files/service.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { EmployeeService } from '~/modules/party/party-service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import {
  attendanceCorrectionResourceMeta,
  attendanceDayResourceMeta,
  attendanceImportResourceMeta,
  attendancePunchResourceMeta,
  employeeLoanResourceMeta,
  payrollPaymentResourceMeta,
  payrollResourceMeta,
} from './meta.ts'
import {
  ATTENDANCE_OFFSET_INTERVAL,
  ATTENDANCE_UTC_OFFSET_MS,
  computeAttendanceDay,
  DAY_MISSING,
  FULL_DAY_HOURS_SQL,
  IMPORT_FAILED,
  IMPORT_IMPORTED,
  IMPORT_PARSED,
  LOAN_BORROW,
  LOAN_REPAY,
  localDate,
  lowerWire,
  parseAttendanceFile,
  PAYMENT_NORMAL,
  PAYMENT_SUPPLEMENT,
  PAYROLL_PAID,
  PAYROLL_PENDING,
  type ParsedPunch,
  unmatchedDetail,
  upperWire,
} from './rules.ts'

// ── wire types ──────────────────────────────────────────────────────────────

export interface AttendancePunch {
  id: string
  attendanceNo: string
  punchedAt: Date
  insertedAt: Date
  employeeId: string
  importId: string
}

export interface AttendanceImport {
  id: string
  status: string
  error: string | null
  totalRows: number | null
  badRows: number | null
  dupRows: number | null
  matchedRows: number | null
  unmatchedRows: number | null
  unmatchedDetail: string | null
  importedCount: number | null
  skippedExistingRows: number | null
  skippedUnmatchedRows: number | null
  autoCreatedCount: number | null
  importedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  fileId: string
  createdById: string | null
  importedById: string | null
  punchCount: number
}

export interface AttendanceDay {
  id: string
  date: string
  morningIn: string | null
  morningOut: string | null
  afternoonIn: string | null
  afternoonOut: string | null
  normalHours: string
  overtimeHours: string
  bonusWorkday: string
  status: string
  insertedAt: Date
  updatedAt: Date
  employeeId: string
}

export interface AttendanceMonthSummary {
  employeeId: string
  employeeCode: string
  employeeName: string
  days: number
  missingDays: number
  normalHours: string
  overtimeHours: string
  bonusWorkdays: string
  workdays: string
}

export interface AttendanceCorrection {
  id: string
  date: string
  times: string[]
  note: string | null
  insertedAt: Date
  updatedAt: Date
  employeeId: string
  createdById: string | null
}

export interface Payroll {
  id: string
  month: string
  workdays: string
  attendanceDays: number
  missingDays: number
  overtimeHours: string
  dailyWage: string
  baseAmount: string
  allowance: string
  bonus: string
  fine: string
  loanDeduction: string
  payable: string
  status: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  employeeId: string
  paidTotal: string | null
}

export interface PayrollPayment {
  id: string
  month: string | null
  paidOn: string
  amount: string
  kind: string | null
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  payrollId: string
  employeeId: string | null
  createdById: string | null
}

export interface EmployeeLoan {
  id: string
  kind: string
  occurredOn: string
  amount: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  employeeId: string
  payrollId: string | null
  createdById: string | null
}

export interface EmployeeLoanBalance {
  employeeId: string
  employeeCode: string
  employeeName: string
  borrowed: string
  repaid: string
  balance: string
}

export interface PayrollInput {
  employeeId: string
  month: string
  workdays?: string
  attendanceDays?: number
  missingDays?: number
  overtimeHours?: string
  dailyWage?: string
  allowance?: string
  bonus?: string
  fine?: string
  loanDeduction?: string
  remarks?: string | null
}

interface AttendancePair {
  employeeId: string
  date: string
}

const GENERIC_WRITE = [
  { code: '23505', message: '记录违反唯一约束' },
  { code: '23503', message: '记录已被引用或引用对象不存在' },
] as const

const PAYROLL_AUDIT = [
  'month',
  'workdays',
  'attendance_days',
  'missing_days',
  'overtime_hours',
  'daily_wage',
  'base_amount',
  'allowance',
  'bonus',
  'fine',
  'loan_deduction',
  'payable',
  'status',
  'remarks',
  'employee_id',
] as const

const PAYMENT_AUDIT = [
  'month',
  'paid_on',
  'amount',
  'kind',
  'remarks',
  'payroll_id',
  'employee_id',
  'created_by_id',
] as const

const LOAN_AUDIT = [
  'kind',
  'occurred_on',
  'amount',
  'remarks',
  'employee_id',
  'payroll_id',
  'created_by_id',
] as const

const CORRECTION_AUDIT = ['date', 'times', 'note', 'employee_id', 'created_by_id'] as const

const IMPORT_AUDIT = [
  'status',
  'error',
  'total_rows',
  'bad_rows',
  'dup_rows',
  'matched_rows',
  'unmatched_rows',
  'unmatched_detail',
  'imported_count',
  'skipped_existing_rows',
  'skipped_unmatched_rows',
  'auto_created_count',
  'imported_at',
  'file_id',
  'created_by_id',
  'imported_by_id',
] as const

export interface HrServiceDeps {
  db: Kysely<Database>
  files: FileService
  /** 员工写路径接缝：考勤导入自动建档经 party EmployeeService */
  employeeSeam: Pick<EmployeeService, 'autoCreateForAttendance'>
}

export function createHrService(deps: HrServiceDeps) {
  const { db, files, employeeSeam } = deps

  // ── punches ────────────────────────────────────────────────────────────

  async function listPunches(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: attendancePunchResourceMeta(),
      source: sql` FROM hr_attendance_punch`,
      select: sql`SELECT id, attendance_no,
        to_char(punched_at, 'YYYY-MM-DD"T"HH24:MI:SS".000Z"') AS punched_at,
        to_char(inserted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS inserted_at,
        employee_id, import_id`,
      defaultOrder: sql`"punched_at" ASC, "id" ASC`,
      query,
      mapRow: mapPunchRow,
    })
  }

  async function getPunch(id: string): Promise<AttendancePunch> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, attendance_no,
        to_char(punched_at, 'YYYY-MM-DD"T"HH24:MI:SS".000Z"') AS punched_at,
        to_char(inserted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS inserted_at,
        employee_id, import_id
        FROM hr_attendance_punch WHERE id = ${id}::uuid
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '打卡记录不存在')
    return mapPunchRow(r)
  }

  // ── imports ────────────────────────────────────────────────────────────

  async function listImports(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: attendanceImportResourceMeta(),
      source: sql` FROM hr_attendance_import i`,
      select: sql`SELECT i.id, i.status, i.error, i.total_rows, i.bad_rows, i.dup_rows,
        i.matched_rows, i.unmatched_rows, i.unmatched_detail, i.imported_count,
        i.skipped_existing_rows, i.skipped_unmatched_rows, i.auto_created_count,
        i.imported_at, i.inserted_at, i.updated_at, i.file_id, i.created_by_id,
        i.imported_by_id,
        (SELECT count(*) FROM hr_attendance_punch p WHERE p.import_id = i.id) AS punch_count`,
      defaultOrder: sql`"inserted_at" DESC, "id" ASC`,
      query,
      mapRow: mapImportRow,
    })
  }

  async function getImport(handle: DbHandle, id: string): Promise<AttendanceImport> {
    const row = await sql<Record<string, unknown>>`
      SELECT i.id, i.status, i.error, i.total_rows, i.bad_rows, i.dup_rows,
        i.matched_rows, i.unmatched_rows, i.unmatched_detail, i.imported_count,
        i.skipped_existing_rows, i.skipped_unmatched_rows, i.auto_created_count,
        i.imported_at, i.inserted_at, i.updated_at, i.file_id, i.created_by_id,
        i.imported_by_id,
        (SELECT count(*) FROM hr_attendance_punch p WHERE p.import_id = i.id) AS punch_count
        FROM hr_attendance_import i WHERE i.id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '考勤导入批次不存在')
    return mapImportRow(r)
  }

  async function createImport(actor: Actor, fileId: string): Promise<AttendanceImport> {
    requirePermission(actor, 'hr.attendance_punch:import')
    requirePermission(actor, 'sys.file:read')
    if (!fileId) {
      throw ApiError.validation('考勤导入参数不合法', { fileId: ['不能为空'] })
    }
    const { file, content } = await files.readStoredFile(fileId)
    return withTx(db, async (trx) => {
      if (file.sha256) {
        const dup = await sql<{ exists: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM hr_attendance_import i
            JOIN sys_file f ON f.id = i.file_id
            WHERE f.sha256 = ${file.sha256} AND i.status <> 'failed'
          ) AS exists
        `.execute(trx)
        if (dup.rows[0]?.exists) {
          throw new ApiError(
            'conflict',
            '已存在相同文件的导入批次,如需重新导入请先删除原批次',
          )
        }
      }
      let status = IMPORT_PARSED
      let errorText: string | null = null
      let total: number | null = null
      let bad: number | null = null
      let dupRows: number | null = null
      let matched: number | null = null
      let unmatched: number | null = null
      let detail: string | null = null
      try {
        const parsed = parseAttendanceFile(content)
        total = parsed.totalRows
        bad = parsed.badRows
        dupRows = parsed.dupRows
        const employeeMap = await loadEmployeeMap(trx, parsed.rows)
        let matchedValue = 0
        for (const row of parsed.rows) {
          if (employeeMap.has(row.attendanceNo)) matchedValue++
        }
        matched = matchedValue
        unmatched = parsed.rows.length - matchedValue
        detail = unmatchedDetail(parsed.rows, employeeMap)
      } catch (err) {
        status = IMPORT_FAILED
        let message = err instanceof Error ? err.message : String(err)
        if (message.length > 500) message = message.slice(0, 500)
        errorText = message
      }
      try {
        const inserted = await trx
          .insertInto('hr_attendance_import')
          .values({
            status,
            error: errorText,
            total_rows: total === null ? null : String(total),
            bad_rows: bad === null ? null : String(bad),
            dup_rows: dupRows === null ? null : String(dupRows),
            matched_rows: matched === null ? null : String(matched),
            unmatched_rows: unmatched === null ? null : String(unmatched),
            unmatched_detail: detail,
            file_id: fileId,
            created_by_id: actor.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const item = await getImport(trx, inserted.id)
        await writeAudit(trx, actor, {
          resource: 'hr_attendance_import',
          recordId: item.id,
          recordLabel: errorText ?? '',
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(importSnap(item), IMPORT_AUDIT),
        })
        return item
      } catch (err) {
        throw writeErr(err, '创建考勤导入失败')
      }
    })
  }

  async function executeImport(
    actor: Actor,
    id: string,
    input: { autoCreateEmployees?: boolean },
  ): Promise<AttendanceImport> {
    requirePermission(actor, 'hr.attendance_punch:import')
    return withTx(db, async (trx) => {
      const locked = await sql<{ file_id: string; status: string }>`
        SELECT file_id, status FROM hr_attendance_import WHERE id = ${id}::uuid FOR UPDATE
      `.execute(trx)
      const row = locked.rows[0]
      if (!row) throw new ApiError('not_found', '考勤导入批次不存在')
      if (row.status !== IMPORT_PARSED) {
        throw new ApiError('conflict', '仅「已解析」状态的批次可执行导入')
      }
      const { content } = await files.readStoredFile(row.file_id)
      let parsed
      try {
        parsed = parseAttendanceFile(content)
      } catch (err) {
        throw ApiError.validation('考勤文件无法重新解析', {
          fileId: [err instanceof Error ? err.message : String(err)],
        })
      }
      const employees = await loadEmployeeMap(trx, parsed.rows)
      const missing = missingAttendanceNos(parsed.rows, employees)
      let autoCreated = 0
      if (input.autoCreateEmployees && missing.length > 0) {
        if (!hasPermission(actor, 'hr.employee:create')) {
          throw new ApiError(
            'forbidden',
            '无权自动创建员工(需要「员工-新增」权限),可去掉勾选仅导入已匹配的行',
          )
        }
        for (const no of missing) {
          try {
            const emp = await employeeSeam.autoCreateForAttendance(trx, actor, no)
            employees.set(no, emp.id)
            autoCreated++
          } catch (err) {
            throw writeErr(err, '自动创建员工失败')
          }
        }
      }
      let imported = 0
      let skippedExisting = 0
      let skippedUnmatched = 0
      const pairs = new Map<string, AttendancePair>()
      for (const punch of parsed.rows) {
        const employeeId = employees.get(punch.attendanceNo)
        if (!employeeId) {
          skippedUnmatched++
          continue
        }
        const exists = await sql<{ exists: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM hr_attendance_punch
             WHERE employee_id = ${employeeId}::uuid AND punched_at = ${tsParam(punch.punchedAt)}
          ) AS exists
        `.execute(trx)
        if (exists.rows[0]?.exists) {
          skippedExisting++
          continue
        }
        try {
          await sql`
            INSERT INTO hr_attendance_punch(attendance_no, punched_at, employee_id, import_id)
            VALUES (
              ${punch.attendanceNo},
              ${tsParam(punch.punchedAt)},
              ${employeeId}::uuid,
              ${id}::uuid
            )
          `.execute(trx)
        } catch (err) {
          throw writeErr(err, '写入打卡失败')
        }
        imported++
        const date = localDate(punch.punchedAt)
        pairs.set(`${employeeId}\0${date}`, { employeeId, date })
      }
      const now = new Date()
      try {
        await sql`
          UPDATE hr_attendance_import SET
            status = ${IMPORT_IMPORTED},
            imported_count = ${imported},
            skipped_existing_rows = ${skippedExisting},
            skipped_unmatched_rows = ${skippedUnmatched},
            auto_created_count = ${autoCreated},
            imported_at = ${tsParam(now)},
            imported_by_id = ${actor.userId}::uuid,
            updated_at = ${tsParam(now)}
          WHERE id = ${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw writeErr(err, '更新考勤导入失败')
      }
      await recomputePairs(trx, [...pairs.values()])
      await writeAudit(trx, actor, {
        resource: 'hr_attendance_import',
        recordId: id,
        recordLabel: '',
        actionType: 'update',
        actionName: 'import',
        changes: {
          status: { from: IMPORT_PARSED, to: IMPORT_IMPORTED },
          imported_count: { to: imported },
          skipped_existing_rows: { to: skippedExisting },
          skipped_unmatched_rows: { to: skippedUnmatched },
          auto_created_count: { to: autoCreated },
          imported_at: { to: now.toISOString() },
          imported_by_id: { to: actor.userId },
        },
      })
      return getImport(trx, id)
    })
  }

  async function deleteImport(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.attendance_punch:import')
    await withTx(db, async (trx) => {
      const before = await getImport(trx, id)
      const punches = await sql<{ employee_id: string; punched_at: Date | string }>`
        SELECT employee_id, punched_at FROM hr_attendance_punch WHERE import_id = ${id}::uuid
      `.execute(trx)
      const pairs = new Map<string, AttendancePair>()
      for (const p of punches.rows) {
        const date = localDate(asDate(p.punched_at))
        pairs.set(`${p.employee_id}\0${date}`, { employeeId: p.employee_id, date })
      }
      try {
        await trx.deleteFrom('hr_attendance_import').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除考勤导入失败')
      }
      await recomputePairs(trx, [...pairs.values()])
      await writeAudit(trx, actor, {
        resource: 'hr_attendance_import',
        recordId: id,
        recordLabel: before.error ?? '',
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(importSnap(before), IMPORT_AUDIT),
      })
    })
  }

  // ── days ───────────────────────────────────────────────────────────────

  async function listDays(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: attendanceDayResourceMeta(),
      source: sql` FROM hr_attendance_day`,
      select: sql`SELECT id, date, to_char(morning_in,'HH24:MI:SS') AS morning_in,
        to_char(morning_out,'HH24:MI:SS') AS morning_out,
        to_char(afternoon_in,'HH24:MI:SS') AS afternoon_in,
        to_char(afternoon_out,'HH24:MI:SS') AS afternoon_out,
        normal_hours, overtime_hours, bonus_workday, status,
        inserted_at, updated_at, employee_id`,
      defaultOrder: sql`"date" DESC, "id" ASC`,
      query,
      mapRow: mapDayRow,
    })
  }

  async function getDay(id: string): Promise<AttendanceDay> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, date, to_char(morning_in,'HH24:MI:SS') AS morning_in,
        to_char(morning_out,'HH24:MI:SS') AS morning_out,
        to_char(afternoon_in,'HH24:MI:SS') AS afternoon_in,
        to_char(afternoon_out,'HH24:MI:SS') AS afternoon_out,
        normal_hours, overtime_hours, bonus_workday, status,
        inserted_at, updated_at, employee_id
        FROM hr_attendance_day WHERE id = ${id}::uuid
    `.execute(db)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '日考勤不存在')
    return mapDayRow(r)
  }

  async function recalcDays(actor: Actor, dateFrom: string, dateTo: string): Promise<number> {
    requirePermission(actor, 'hr.attendance_day:recalc')
    const from = parseDate(dateFrom, 'dateFrom')
    const to = parseDate(dateTo, 'dateTo')
    if (to.getTime() < from.getTime()) {
      throw ApiError.validation('重算区间不合法', { dateTo: ['结束日期不能早于开始日期'] })
    }
    if ((to.getTime() - from.getTime()) / 86400000 > 366) {
      throw ApiError.validation('重算区间不合法', { dateTo: ['重算区间不能超过一年'] })
    }
    const pairsResult = await sql<{ employee_id: string; local_date: Date | string }>`
      SELECT employee_id, local_date FROM (
        SELECT employee_id, (punched_at + interval ${sql.raw(`'${ATTENDANCE_OFFSET_INTERVAL}'`)})::date AS local_date
          FROM hr_attendance_punch
         WHERE (punched_at + interval ${sql.raw(`'${ATTENDANCE_OFFSET_INTERVAL}'`)})::date BETWEEN ${dateFrom}::date AND ${dateTo}::date
        UNION
        SELECT employee_id, date FROM hr_attendance_correction
         WHERE date BETWEEN ${dateFrom}::date AND ${dateTo}::date
        UNION
        SELECT employee_id, date FROM hr_attendance_day
         WHERE date BETWEEN ${dateFrom}::date AND ${dateTo}::date
      ) pairs ORDER BY employee_id, local_date
    `.execute(db)
    // 旧 generic action transaction?=false；每个 pair 独立提交
    for (const row of pairsResult.rows) {
      const pair: AttendancePair = {
        employeeId: row.employee_id,
        date: asDateOnly(row.local_date),
      }
      await withTx(db, async (trx) => {
        await recomputePair(trx, pair)
      })
    }
    return pairsResult.rows.length
  }

  async function monthSummary(month: string): Promise<AttendanceMonthSummary[]> {
    const first = parseMonth(month)
    const next = addMonth(first)
    const rows = await sql<Record<string, unknown>>`
      SELECT d.employee_id, e.code, e.name, count(*)::bigint AS days,
             count(*) FILTER (WHERE d.status = 'missing')::bigint AS missing_days,
             COALESCE(sum(d.normal_hours), 0) AS normal_hours,
             COALESCE(sum(d.overtime_hours), 0) AS overtime_hours,
             COALESCE(sum(d.bonus_workday), 0) AS bonus_workdays,
             COALESCE(sum(d.normal_hours), 0) / ${sql.raw(FULL_DAY_HOURS_SQL)}
               + COALESCE(sum(d.bonus_workday), 0) AS workdays
        FROM hr_attendance_day d
        JOIN hr_employees e ON e.id = d.employee_id
       WHERE d.date >= ${first}::date AND d.date < ${next}::date
       GROUP BY d.employee_id, e.code, e.name
       ORDER BY e.code, e.name
    `.execute(db)
    return rows.rows.map((r) => ({
      employeeId: String(r.employee_id),
      employeeCode: String(r.code),
      employeeName: String(r.name),
      days: Number(r.days),
      missingDays: Number(r.missing_days),
      normalHours: numStr(r.normal_hours),
      overtimeHours: numStr(r.overtime_hours),
      bonusWorkdays: numStr(r.bonus_workdays),
      workdays: numStr(r.workdays),
    }))
  }

  // ── corrections ────────────────────────────────────────────────────────

  async function listCorrections(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: attendanceCorrectionResourceMeta(),
      source: sql` FROM hr_attendance_correction`,
      select: sql`SELECT id, date,
        ARRAY(SELECT to_char(value,'HH24:MI:SS') FROM unnest(times) value ORDER BY value) AS times,
        note, inserted_at, updated_at, employee_id, created_by_id`,
      defaultOrder: sql`"date" DESC, "id" ASC`,
      query,
      mapRow: mapCorrectionRow,
    })
  }

  async function getCorrection(handle: DbHandle, id: string): Promise<AttendanceCorrection> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, date,
        ARRAY(SELECT to_char(value,'HH24:MI:SS') FROM unnest(times) value ORDER BY value) AS times,
        note, inserted_at, updated_at, employee_id, created_by_id
        FROM hr_attendance_correction WHERE id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '补卡单不存在')
    return mapCorrectionRow(r)
  }

  async function createCorrection(
    actor: Actor,
    input: { employeeId: string; date: string; times: string[]; note?: string | null },
  ): Promise<AttendanceCorrection> {
    requirePermission(actor, 'hr.attendance_correction:create')
    validateCorrectionNote(input.note)
    const { date, times } = validateCorrectionInput(input.date, input.times)
    return withTx(db, async (trx) => {
      try {
        const inserted = await sql<{ id: string }>`
          INSERT INTO hr_attendance_correction(date, times, note, employee_id, created_by_id)
          VALUES (
            ${date}::date,
            ARRAY(SELECT value::time FROM unnest(${times}::text[]) value),
            ${input.note ?? null},
            ${input.employeeId}::uuid,
            ${actor.userId}::uuid
          ) RETURNING id
        `.execute(trx)
        const id = inserted.rows[0]!.id
        await recomputePair(trx, { employeeId: input.employeeId, date })
        const item = await getCorrection(trx, id)
        await writeAudit(trx, actor, {
          resource: 'hr_attendance_correction',
          recordId: id,
          recordLabel: date,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(correctionSnap(item), CORRECTION_AUDIT),
        })
        return item
      } catch (err) {
        throw writeErr(err, '创建补卡单失败')
      }
    })
  }

  async function updateCorrection(
    actor: Actor,
    id: string,
    input: {
      employeeId?: string
      date?: string
      times?: string[]
      note?: string | null
      notePresent?: boolean
    },
  ): Promise<AttendanceCorrection> {
    requirePermission(actor, 'hr.attendance_correction:update')
    return withTx(db, async (trx) => {
      const before = await getCorrection(trx, id)
      const after = {
        employeeId: input.employeeId ?? before.employeeId,
        date: input.date ?? before.date,
        times: input.times ?? before.times,
        note: input.notePresent ? (input.note ?? null) : before.note,
      }
      validateCorrectionNote(after.note)
      const { date, times } = validateCorrectionInput(after.date, after.times)
      try {
        await sql`
          UPDATE hr_attendance_correction SET
            date = ${date}::date,
            times = ARRAY(SELECT value::time FROM unnest(${times}::text[]) value),
            note = ${after.note},
            employee_id = ${after.employeeId}::uuid,
            updated_at = (now() AT TIME ZONE 'utc')
          WHERE id = ${id}::uuid
        `.execute(trx)
      } catch (err) {
        throw writeErr(err, '更新补卡单失败')
      }
      const pairs = new Map<string, AttendancePair>()
      pairs.set(`${before.employeeId}\0${before.date}`, {
        employeeId: before.employeeId,
        date: before.date,
      })
      pairs.set(`${after.employeeId}\0${date}`, { employeeId: after.employeeId, date })
      await recomputePairs(trx, [...pairs.values()])
      const item = await getCorrection(trx, id)
      const changes = auditDiff(correctionSnap(before), correctionSnap(item), CORRECTION_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_attendance_correction',
          recordId: id,
          recordLabel: item.date,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return item
    })
  }

  async function deleteCorrection(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.attendance_correction:delete')
    await withTx(db, async (trx) => {
      const before = await getCorrection(trx, id)
      try {
        await trx.deleteFrom('hr_attendance_correction').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除补卡单失败')
      }
      await recomputePair(trx, { employeeId: before.employeeId, date: before.date })
      await writeAudit(trx, actor, {
        resource: 'hr_attendance_correction',
        recordId: id,
        recordLabel: before.date,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(correctionSnap(before), CORRECTION_AUDIT),
      })
    })
  }

  // ── payrolls ───────────────────────────────────────────────────────────

  async function listPayrolls(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: payrollResourceMeta(),
      source: sql` FROM hr_payroll p`,
      select: sql`SELECT p.id, p.month, p.workdays, p.attendance_days, p.missing_days,
        p.overtime_hours, p.daily_wage, p.base_amount, p.allowance, p.bonus, p.fine,
        p.loan_deduction, p.payable, p.status, p.remarks, p.inserted_at, p.updated_at,
        p.employee_id,
        (SELECT sum(payment.amount) FROM hr_payroll_payment payment
          WHERE payment.payroll_id = p.id) AS paid_total`,
      defaultOrder: sql`"month" DESC, "id" ASC`,
      query,
      mapRow: mapPayrollRow,
    })
  }

  async function getPayroll(handle: DbHandle, id: string): Promise<Payroll> {
    const row = await sql<Record<string, unknown>>`
      SELECT p.id, p.month, p.workdays, p.attendance_days, p.missing_days,
        p.overtime_hours, p.daily_wage, p.base_amount, p.allowance, p.bonus, p.fine,
        p.loan_deduction, p.payable, p.status, p.remarks, p.inserted_at, p.updated_at,
        p.employee_id,
        (SELECT sum(payment.amount) FROM hr_payroll_payment payment
          WHERE payment.payroll_id = p.id) AS paid_total
        FROM hr_payroll p WHERE p.id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '工资单不存在')
    return mapPayrollRow(r)
  }

  async function createPayroll(actor: Actor, input: PayrollInput): Promise<Payroll> {
    requirePermission(actor, 'hr.payroll:create')
    const normalized = normalizePayrollInput(input)
    return withTx(db, async (trx) => {
      const item = await insertPayroll(trx, normalized)
      await writeAudit(trx, actor, {
        resource: 'hr_payroll',
        recordId: item.id,
        recordLabel: item.month,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(payrollSnap(item), PAYROLL_AUDIT),
      })
      return item
    })
  }

  async function updatePayroll(
    actor: Actor,
    id: string,
    input: {
      workdays?: string
      attendanceDays?: number
      missingDays?: number
      overtimeHours?: string
      dailyWage?: string
      allowance?: string
      bonus?: string
      fine?: string
      loanDeduction?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<Payroll> {
    requirePermission(actor, 'hr.payroll:update')
    return withTx(db, async (trx) => {
      const before = await lockPayroll(trx, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可修改或删除,差错请走补发')
      }
      const normalized = normalizePayrollInput({
        employeeId: before.employeeId,
        month: before.month,
        workdays: input.workdays ?? before.workdays,
        attendanceDays: input.attendanceDays ?? before.attendanceDays,
        missingDays: input.missingDays ?? before.missingDays,
        overtimeHours: input.overtimeHours ?? before.overtimeHours,
        dailyWage: input.dailyWage ?? before.dailyWage,
        allowance: input.allowance ?? before.allowance,
        bonus: input.bonus ?? before.bonus,
        fine: input.fine ?? before.fine,
        loanDeduction: input.loanDeduction ?? before.loanDeduction,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      })
      try {
        await trx
          .updateTable('hr_payroll')
          .set({
            workdays: normalized.workdays,
            attendance_days: String(normalized.attendanceDays),
            missing_days: String(normalized.missingDays),
            overtime_hours: normalized.overtimeHours,
            daily_wage: normalized.dailyWage,
            base_amount: normalized.baseAmount,
            allowance: normalized.allowance,
            bonus: normalized.bonus,
            fine: normalized.fine,
            loan_deduction: normalized.loanDeduction,
            payable: normalized.payable,
            remarks: normalized.remarks,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw writeErr(err, '更新工资单失败')
      }
      const item = await getPayroll(trx, id)
      const changes = auditDiff(payrollSnap(before), payrollSnap(item), PAYROLL_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: id,
          recordLabel: item.month,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return item
    })
  }

  async function refreshPayroll(actor: Actor, id: string): Promise<Payroll> {
    requirePermission(actor, 'hr.payroll:update')
    return withTx(db, async (trx) => {
      const before = await lockPayroll(trx, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可重取快照')
      }
      const snapshot = await payrollSnapshotForEmployee(trx, before.month, before.employeeId)
      const normalized = normalizePayrollInput({
        employeeId: before.employeeId,
        month: before.month,
        workdays: snapshot.workdays,
        attendanceDays: snapshot.attendanceDays,
        missingDays: snapshot.missingDays,
        overtimeHours: snapshot.overtimeHours,
        dailyWage: snapshot.dailyWage,
        allowance: snapshot.allowance,
        bonus: before.bonus,
        fine: before.fine,
        loanDeduction: before.loanDeduction,
        remarks: before.remarks,
      })
      try {
        await trx
          .updateTable('hr_payroll')
          .set({
            workdays: normalized.workdays,
            attendance_days: String(normalized.attendanceDays),
            missing_days: String(normalized.missingDays),
            overtime_hours: normalized.overtimeHours,
            daily_wage: normalized.dailyWage,
            base_amount: normalized.baseAmount,
            allowance: normalized.allowance,
            bonus: normalized.bonus,
            fine: normalized.fine,
            loan_deduction: normalized.loanDeduction,
            payable: normalized.payable,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw writeErr(err, '重取工资单快照失败')
      }
      const item = await getPayroll(trx, id)
      const changes = auditDiff(payrollSnap(before), payrollSnap(item), PAYROLL_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: id,
          recordLabel: item.month,
          actionType: 'update',
          actionName: 'refresh',
          changes,
        })
      }
      return item
    })
  }

  async function deletePayroll(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.payroll:delete')
    await withTx(db, async (trx) => {
      const before = await lockPayroll(trx, id)
      if (before.status !== upperWire(PAYROLL_PENDING)) {
        throw new ApiError('conflict', '仅待发放工资单可修改或删除,差错请走补发')
      }
      try {
        await trx.deleteFrom('hr_payroll').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除工资单失败')
      }
      await writeAudit(trx, actor, {
        resource: 'hr_payroll',
        recordId: id,
        recordLabel: before.month,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(payrollSnap(before), PAYROLL_AUDIT),
      })
    })
  }

  async function generatePayrolls(
    actor: Actor,
    month: string,
  ): Promise<{ created: number; skipped: number }> {
    requirePermission(actor, 'hr.payroll:create')
    const first = parseMonth(month)
    const next = addMonth(first)
    return withTx(db, async (trx) => {
      const skippedRow = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM hr_payroll WHERE month = ${month}
      `.execute(trx)
      const skipped = Number(skippedRow.rows[0]?.count ?? 0)
      const rows = await sql<Record<string, unknown>>`
        SELECT d.employee_id,
               COALESCE(sum(d.normal_hours),0)/${sql.raw(FULL_DAY_HOURS_SQL)}
                 + COALESCE(sum(d.bonus_workday),0) AS workdays,
               count(*)::bigint AS attendance_days,
               count(*) FILTER (WHERE d.status='missing')::bigint AS missing_days,
               COALESCE(sum(d.overtime_hours),0) AS overtime_hours,
               COALESCE(e.daily_wage,0) AS daily_wage,
               COALESCE(e.monthly_allowance,0) AS allowance
          FROM hr_attendance_day d
          JOIN hr_employees e ON e.id = d.employee_id
         WHERE d.date >= ${first}::date AND d.date < ${next}::date
           AND NOT EXISTS(
             SELECT 1 FROM hr_payroll p
              WHERE p.employee_id = d.employee_id AND p.month = ${month}
           )
         GROUP BY d.employee_id, e.daily_wage, e.monthly_allowance
         ORDER BY d.employee_id
      `.execute(trx)
      let created = 0
      for (const r of rows.rows) {
        const normalized = normalizePayrollInput({
          employeeId: String(r.employee_id),
          month,
          workdays: numStr(r.workdays),
          attendanceDays: Number(r.attendance_days),
          missingDays: Number(r.missing_days),
          overtimeHours: numStr(r.overtime_hours),
          dailyWage: numStr(r.daily_wage),
          allowance: numStr(r.allowance),
        })
        const item = await insertPayroll(trx, normalized)
        await writeAudit(trx, actor, {
          resource: 'hr_payroll',
          recordId: item.id,
          recordLabel: item.month,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(payrollSnap(item), PAYROLL_AUDIT),
        })
        created++
      }
      return { created, skipped }
    })
  }

  async function payrollMonthStats(month: string): Promise<{
    count: number
    pendingCount: number
    payableTotal: string
    paidTotal: string
  }> {
    parseMonth(month)
    const row = await sql<Record<string, unknown>>`
      SELECT count(*)::bigint AS count,
             count(*) FILTER (WHERE p.status='pending')::bigint AS pending_count,
             COALESCE(sum(p.payable),0) AS payable_total,
             COALESCE((
               SELECT sum(payment.amount)
                 FROM hr_payroll_payment payment
                 JOIN hr_payroll linked ON linked.id = payment.payroll_id
                WHERE linked.month = ${month}
             ),0) AS paid_total
        FROM hr_payroll p WHERE p.month = ${month}
    `.execute(db)
    const r = row.rows[0]!
    return {
      count: Number(r.count),
      pendingCount: Number(r.pending_count),
      payableTotal: numStr(r.payable_total),
      paidTotal: numStr(r.paid_total),
    }
  }

  // ── payments ───────────────────────────────────────────────────────────

  async function listPayments(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: payrollPaymentResourceMeta(),
      source: sql` FROM hr_payroll_payment`,
      select: sql`SELECT id, month, paid_on, amount, kind, remarks, inserted_at, updated_at,
        payroll_id, employee_id, created_by_id`,
      defaultOrder: sql`"paid_on" DESC, "id" ASC`,
      query,
      mapRow: mapPaymentRow,
    })
  }

  async function getPayment(handle: DbHandle, id: string): Promise<PayrollPayment> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, month, paid_on, amount, kind, remarks, inserted_at, updated_at,
        payroll_id, employee_id, created_by_id
        FROM hr_payroll_payment WHERE id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '工资发放记录不存在')
    return mapPaymentRow(r)
  }

  async function createPayment(
    actor: Actor,
    input: { payrollId: string; paidOn: string; amount: string; remarks?: string | null },
  ): Promise<PayrollPayment> {
    requirePermission(actor, 'hr.payroll_payment:create')
    const amount = parseDecimal(input.amount, 'amount', false, true)
    const paidOn = parseDate(input.paidOn, 'paidOn')
    return withTx(db, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.payrollId}, 0))`.execute(trx)
      const payroll = await lockPayroll(trx, input.payrollId)
      return createPaymentInTx(trx, actor, payroll, paidOn, amount, input.remarks ?? null)
    })
  }

  async function payRemaining(
    actor: Actor,
    input: { payrollId: string; paidOn: string; remarks?: string | null },
  ): Promise<PayrollPayment> {
    requirePermission(actor, 'hr.payroll_payment:create')
    const paidOn = parseDate(input.paidOn, 'paidOn')
    return withTx(db, async (trx) => {
      // 事务级 advisory lock：串行化同工资单发放，避免并发 payRemaining 双成功
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.payrollId}, 0))`.execute(trx)
      const payroll = await lockPayroll(trx, input.payrollId)
      const paidRow = await sql<{ paid: string | null }>`
        SELECT COALESCE(sum(amount),0)::text AS paid
          FROM hr_payroll_payment WHERE payroll_id = ${payroll.id}::uuid
      `.execute(trx)
      const paid = decimal(paidRow.rows[0]?.paid ?? '0')
      const remaining = decimal(payroll.payable).sub(paid)
      if (!remaining.gt(0)) {
        throw new ApiError('conflict', '该工资单已无未发差额')
      }
      return createPaymentInTx(trx, actor, payroll, paidOn, remaining, input.remarks ?? null)
    })
  }

  async function createPaymentInTx(
    trx: DbHandle,
    actor: Actor,
    payroll: Payroll,
    paidOn: Date,
    amount: ReturnType<typeof decimal>,
    remarks: string | null,
  ): Promise<PayrollPayment> {
    let kind = PAYMENT_SUPPLEMENT
    if (payroll.status === upperWire(PAYROLL_PENDING)) {
      kind = PAYMENT_NORMAL
      const deduction = decimal(payroll.loanDeduction)
      if (deduction.gt(0)) {
        const bal = await sql<{ balance: string }>`
          SELECT COALESCE(sum(CASE kind WHEN 'borrow' THEN amount ELSE -amount END),0)::text AS balance
            FROM hr_employee_loan WHERE employee_id = ${payroll.employeeId}::uuid
        `.execute(trx)
        if (decimal(bal.rows[0]?.balance ?? '0').lessThan(deduction)) {
          throw new ApiError('conflict', '借款抵扣超过员工借款余额')
        }
      }
    }
    let id: string
    try {
      const inserted = await trx
        .insertInto('hr_payroll_payment')
        .values({
          month: payroll.month,
          paid_on: asDateOnly(paidOn),
          amount: toDecimalString(amount),
          kind,
          remarks,
          payroll_id: payroll.id,
          employee_id: payroll.employeeId,
          created_by_id: actor.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      id = inserted.id
    } catch (err) {
      throw writeErr(err, '创建工资发放失败')
    }
    const value = await getPayment(trx, id)
    await writeAudit(trx, actor, {
      resource: 'hr_payroll_payment',
      recordId: id,
      recordLabel: payroll.month,
      actionType: 'create',
      actionName: 'create',
      changes: auditCreated(paymentSnap(value), PAYMENT_AUDIT),
    })
    if (kind === PAYMENT_NORMAL) {
      try {
        await trx
          .updateTable('hr_payroll')
          .set({ status: PAYROLL_PAID, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', payroll.id)
          .execute()
      } catch (err) {
        throw writeErr(err, '更新工资单状态失败')
      }
      await writeAudit(trx, actor, {
        resource: 'hr_payroll',
        recordId: payroll.id,
        recordLabel: payroll.month,
        actionType: 'update',
        actionName: 'mark_paid',
        changes: { status: { from: PAYROLL_PENDING, to: PAYROLL_PAID } },
      })
      const deduction = decimal(payroll.loanDeduction)
      if (deduction.gt(0)) {
        try {
          const loanIns = await trx
            .insertInto('hr_employee_loan')
            .values({
              kind: LOAN_REPAY,
              occurred_on: asDateOnly(paidOn),
              amount: toDecimalString(deduction),
              employee_id: payroll.employeeId,
              payroll_id: payroll.id,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          const loan = await getLoan(trx, loanIns.id)
          await writeAudit(trx, actor, {
            resource: 'hr_employee_loan',
            recordId: loan.id,
            recordLabel: loan.occurredOn,
            actionType: 'create',
            actionName: 'auto_repay',
            changes: auditCreated(loanSnap(loan), LOAN_AUDIT),
          })
        } catch (err) {
          throw writeErr(err, '写入自动借款归还失败')
        }
      }
    }
    return value
  }

  async function deletePayment(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.payroll_payment:delete')
    await withTx(db, async (trx) => {
      const payRow = await sql<{ payroll_id: string }>`
        SELECT payroll_id FROM hr_payroll_payment WHERE id = ${id}::uuid
      `.execute(trx)
      if (!payRow.rows[0]) throw new ApiError('not_found', '工资发放记录不存在')
      const payroll = await lockPayroll(trx, payRow.rows[0].payroll_id)
      const value = await getPayment(trx, id)
      try {
        await trx.deleteFrom('hr_payroll_payment').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除工资发放失败')
      }
      const remaining = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM hr_payroll_payment
         WHERE payroll_id = ${payroll.id}::uuid
      `.execute(trx)
      const remainingCount = Number(remaining.rows[0]?.count ?? 0)
      const isNormal = value.kind === upperWire(PAYMENT_NORMAL)
      if (isNormal || remainingCount === 0) {
        if (payroll.status === upperWire(PAYROLL_PAID)) {
          try {
            await trx
              .updateTable('hr_payroll')
              .set({ status: PAYROLL_PENDING, updated_at: sql`(now() AT TIME ZONE 'utc')` })
              .where('id', '=', payroll.id)
              .execute()
          } catch (err) {
            throw writeErr(err, '回退工资单状态失败')
          }
          await writeAudit(trx, actor, {
            resource: 'hr_payroll',
            recordId: payroll.id,
            recordLabel: payroll.month,
            actionType: 'update',
            actionName: 'mark_pending',
            changes: { status: { from: PAYROLL_PAID, to: PAYROLL_PENDING } },
          })
        }
        const loans = await sql<Record<string, unknown>>`
          SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
            employee_id, payroll_id, created_by_id
            FROM hr_employee_loan WHERE payroll_id = ${payroll.id}::uuid FOR UPDATE
        `.execute(trx)
        for (const raw of loans.rows) {
          const loan = mapLoanRow(raw)
          try {
            await trx.deleteFrom('hr_employee_loan').where('id', '=', loan.id).execute()
          } catch (err) {
            throw writeErr(err, '删除自动借款归还失败')
          }
          await writeAudit(trx, actor, {
            resource: 'hr_employee_loan',
            recordId: loan.id,
            recordLabel: loan.occurredOn,
            actionType: 'destroy',
            actionName: 'auto_destroy',
            changes: auditDestroyed(loanSnap(loan), LOAN_AUDIT),
          })
        }
      }
      await writeAudit(trx, actor, {
        resource: 'hr_payroll_payment',
        recordId: id,
        recordLabel: payroll.month,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(paymentSnap(value), PAYMENT_AUDIT),
      })
    })
  }

  // ── loans ──────────────────────────────────────────────────────────────

  async function listLoans(query: Partial<ListQuery>) {
    return listFromSource({
      db,
      resource: employeeLoanResourceMeta(),
      source: sql` FROM hr_employee_loan`,
      select: sql`SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
        employee_id, payroll_id, created_by_id`,
      defaultOrder: sql`"occurred_on" DESC, "id" ASC`,
      query,
      mapRow: mapLoanRow,
    })
  }

  async function getLoan(handle: DbHandle, id: string): Promise<EmployeeLoan> {
    const row = await sql<Record<string, unknown>>`
      SELECT id, kind, occurred_on, amount, remarks, inserted_at, updated_at,
        employee_id, payroll_id, created_by_id
        FROM hr_employee_loan WHERE id = ${id}::uuid
    `.execute(handle)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '员工借款记录不存在')
    return mapLoanRow(r)
  }

  async function createLoan(
    actor: Actor,
    input: {
      employeeId: string
      kind: string
      occurredOn: string
      amount: string
      remarks?: string | null
    },
  ): Promise<EmployeeLoan> {
    requirePermission(actor, 'hr.employee_loan:create')
    const { kind, occurredOn, amount } = normalizeLoanInput(
      input.kind,
      input.occurredOn,
      input.amount,
    )
    return withTx(db, async (trx) => {
      try {
        const inserted = await trx
          .insertInto('hr_employee_loan')
          .values({
            kind,
            occurred_on: asDateOnly(occurredOn),
            amount: toDecimalString(amount),
            remarks: input.remarks ?? null,
            employee_id: input.employeeId,
            created_by_id: actor.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const item = await getLoan(trx, inserted.id)
        await writeAudit(trx, actor, {
          resource: 'hr_employee_loan',
          recordId: item.id,
          recordLabel: item.occurredOn,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(loanSnap(item), LOAN_AUDIT),
        })
        return item
      } catch (err) {
        throw writeErr(err, '创建员工借款失败')
      }
    })
  }

  async function updateLoan(
    actor: Actor,
    id: string,
    input: {
      employeeId?: string
      kind?: string
      occurredOn?: string
      amount?: string
      remarks?: string | null
      remarksPresent?: boolean
    },
  ): Promise<EmployeeLoan> {
    requirePermission(actor, 'hr.employee_loan:update')
    return withTx(db, async (trx) => {
      const before = await getLoan(trx, id)
      if (before.payrollId) {
        throw new ApiError(
          'conflict',
          '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理',
        )
      }
      const { kind, occurredOn, amount } = normalizeLoanInput(
        input.kind ?? before.kind,
        input.occurredOn ?? before.occurredOn,
        input.amount ?? before.amount,
      )
      const employeeId = input.employeeId ?? before.employeeId
      const remarks = input.remarksPresent ? (input.remarks ?? null) : before.remarks
      try {
        await trx
          .updateTable('hr_employee_loan')
          .set({
            kind,
            occurred_on: asDateOnly(occurredOn),
            amount: toDecimalString(amount),
            remarks,
            employee_id: employeeId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw writeErr(err, '更新员工借款失败')
      }
      const item = await getLoan(trx, id)
      const changes = auditDiff(loanSnap(before), loanSnap(item), LOAN_AUDIT)
      if (Object.keys(changes).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'hr_employee_loan',
          recordId: id,
          recordLabel: item.occurredOn,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
      }
      return item
    })
  }

  async function deleteLoan(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'hr.employee_loan:delete')
    await withTx(db, async (trx) => {
      const before = await getLoan(trx, id)
      if (before.payrollId) {
        throw new ApiError(
          'conflict',
          '工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理',
        )
      }
      try {
        await trx.deleteFrom('hr_employee_loan').where('id', '=', id).execute()
      } catch (err) {
        throw writeErr(err, '删除员工借款失败')
      }
      await writeAudit(trx, actor, {
        resource: 'hr_employee_loan',
        recordId: id,
        recordLabel: before.occurredOn,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(loanSnap(before), LOAN_AUDIT),
      })
    })
  }

  async function loanBalances(): Promise<EmployeeLoanBalance[]> {
    const rows = await sql<Record<string, unknown>>`
      SELECT l.employee_id, e.code, e.name,
             COALESCE(sum(l.amount) FILTER (WHERE l.kind='borrow'),0) AS borrowed,
             COALESCE(sum(l.amount) FILTER (WHERE l.kind='repay'),0) AS repaid
        FROM hr_employee_loan l
        JOIN hr_employees e ON e.id = l.employee_id
       GROUP BY l.employee_id, e.code, e.name
       ORDER BY e.code, e.name
    `.execute(db)
    return rows.rows.map((r) => {
      const borrowed = numStr(r.borrowed)
      const repaid = numStr(r.repaid)
      return {
        employeeId: String(r.employee_id),
        employeeCode: String(r.code),
        employeeName: String(r.name),
        borrowed,
        repaid,
        balance: toDecimalString(decimal(borrowed).sub(decimal(repaid))),
      }
    })
  }

  // ── internal helpers ───────────────────────────────────────────────────

  async function insertPayroll(
    trx: DbHandle,
    n: ReturnType<typeof normalizePayrollInput>,
  ): Promise<Payroll> {
    try {
      const inserted = await trx
        .insertInto('hr_payroll')
        .values({
          month: n.month,
          workdays: n.workdays,
          attendance_days: String(n.attendanceDays),
          missing_days: String(n.missingDays),
          overtime_hours: n.overtimeHours,
          daily_wage: n.dailyWage,
          base_amount: n.baseAmount,
          allowance: n.allowance,
          bonus: n.bonus,
          fine: n.fine,
          loan_deduction: n.loanDeduction,
          payable: n.payable,
          remarks: n.remarks,
          employee_id: n.employeeId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return getPayroll(trx, inserted.id)
    } catch (err) {
      throw writeErr(err, '创建工资单失败')
    }
  }

  async function lockPayroll(trx: DbHandle, id: string): Promise<Payroll> {
    const row = await sql<Record<string, unknown>>`
      SELECT p.id, p.month, p.workdays, p.attendance_days, p.missing_days,
        p.overtime_hours, p.daily_wage, p.base_amount, p.allowance, p.bonus, p.fine,
        p.loan_deduction, p.payable, p.status, p.remarks, p.inserted_at, p.updated_at,
        p.employee_id,
        (SELECT sum(payment.amount) FROM hr_payroll_payment payment
          WHERE payment.payroll_id = p.id) AS paid_total
        FROM hr_payroll p WHERE p.id = ${id}::uuid FOR UPDATE
    `.execute(trx)
    const r = row.rows[0]
    if (!r) throw new ApiError('not_found', '工资单不存在')
    return mapPayrollRow(r)
  }

  async function payrollSnapshotForEmployee(
    trx: DbHandle,
    month: string,
    employeeId: string,
  ): Promise<{
    workdays: string
    attendanceDays: number
    missingDays: number
    overtimeHours: string
    dailyWage: string
    allowance: string
  }> {
    const first = parseMonth(month)
    const next = addMonth(first)
    const row = await sql<Record<string, unknown>>`
      SELECT COALESCE(sum(d.normal_hours),0)/${sql.raw(FULL_DAY_HOURS_SQL)}
               + COALESCE(sum(d.bonus_workday),0) AS workdays,
             count(d.id)::bigint AS attendance_days,
             count(d.id) FILTER (WHERE d.status='missing')::bigint AS missing_days,
             COALESCE(sum(d.overtime_hours),0) AS overtime_hours,
             COALESCE(e.daily_wage,0) AS daily_wage,
             COALESCE(e.monthly_allowance,0) AS allowance
        FROM hr_employees e
        LEFT JOIN hr_attendance_day d
          ON d.employee_id = e.id AND d.date >= ${first}::date AND d.date < ${next}::date
       WHERE e.id = ${employeeId}::uuid
       GROUP BY e.id, e.daily_wage, e.monthly_allowance
    `.execute(trx)
    const r = row.rows[0]
    if (!r) throw new ApiError('conflict', '工资单员工不存在')
    return {
      workdays: numStr(r.workdays),
      attendanceDays: Number(r.attendance_days),
      missingDays: Number(r.missing_days),
      overtimeHours: numStr(r.overtime_hours),
      dailyWage: numStr(r.daily_wage),
      allowance: numStr(r.allowance),
    }
  }

  return {
    listPunches,
    getPunch,
    listImports,
    getImport: (id: string) => getImport(db, id),
    createImport,
    executeImport,
    deleteImport,
    listDays,
    getDay,
    recalcDays,
    monthSummary,
    listCorrections,
    getCorrection: (id: string) => getCorrection(db, id),
    createCorrection,
    updateCorrection,
    deleteCorrection,
    listPayrolls,
    getPayroll: (id: string) => getPayroll(db, id),
    createPayroll,
    updatePayroll,
    refreshPayroll,
    deletePayroll,
    generatePayrolls,
    payrollMonthStats,
    listPayments,
    getPayment: (id: string) => getPayment(db, id),
    createPayment,
    payRemaining,
    deletePayment,
    listLoans,
    getLoan: (id: string) => getLoan(db, id),
    createLoan,
    updateLoan,
    deleteLoan,
    loanBalances,
  }
}

export type HrService = ReturnType<typeof createHrService>

// ── pure helpers ─────────────────────────────────────────────────────────────

function writeErr(err: unknown, message: string): ApiError {
  return mapWriteError(err, message, GENERIC_WRITE)
}

function numStr(value: unknown): string {
  if (value == null) return '0'
  return decimal(String(value)).toFixed()
}

function nullableNumStr(value: unknown): string | null {
  if (value == null) return null
  return decimal(String(value)).toFixed()
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function asDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10)
  }
  // date columns often arrive as midnight UTC
  return value.toISOString().slice(0, 10)
}

function toTs(value: Date): string {
  // timestamp without time zone：写 UTC 墙钟
  return value.toISOString().replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
}

/**
 * postgres.js 会把 timestamp 参数按本地时区重解；经 text 再 cast 可保留 UTC 墙钟字面量。
 * 见 https://github.com/porsager/postgres 对 timestamp without time zone 的序列化行为。
 */
function tsParam(value: Date) {
  return sql`${toTs(value)}::text::timestamp`
}

function toIso(value: Date | string | null | undefined): string {
  if (value == null) return new Date(0).toISOString()
  const d = asDate(value)
  return d.toISOString()
}

function parseDate(value: string, field: string): Date {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))) {
    throw ApiError.validation('日期参数不合法', { [field]: ['格式应为 YYYY-MM-DD'] })
  }
  return new Date(`${trimmed}T00:00:00Z`)
}

function parseMonth(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw ApiError.validation('月份参数不合法', { month: ['格式应为 YYYY-MM'] })
  }
  return `${value}-01`
}

function addMonth(firstOfMonth: string): string {
  const d = new Date(`${firstOfMonth}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

function parseDecimal(
  value: string,
  field: string,
  nonnegative: boolean,
  nonzero: boolean,
): ReturnType<typeof decimal> {
  const trimmed = value.trim()
  if (!isDecimalString(trimmed)) {
    throw ApiError.validation('数值参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  const parsed = decimal(trimmed)
  if (nonnegative && parsed.isNegative()) {
    throw ApiError.validation('数值参数不合法', { [field]: ['不能为负数'] })
  }
  if (nonzero && parsed.isZero()) {
    throw ApiError.validation('数值参数不合法', { [field]: ['不能为零'] })
  }
  return parsed
}

function normalizePayrollInput(input: PayrollInput) {
  if (!input.employeeId) {
    throw ApiError.validation('工资单参数不合法', { employeeId: ['不能为空'] })
  }
  parseMonth(input.month)
  const attendanceDays = input.attendanceDays ?? 0
  const missingDays = input.missingDays ?? 0
  if (attendanceDays < 0 || missingDays < 0) {
    throw ApiError.validation('工资单参数不合法', {
      attendanceDays: ['不能为负数'],
      missingDays: ['不能为负数'],
    })
  }
  const fields = [
    { key: 'workdays', value: input.workdays ?? '0' },
    { key: 'overtimeHours', value: input.overtimeHours ?? '0' },
    { key: 'dailyWage', value: input.dailyWage ?? '0' },
    { key: 'allowance', value: input.allowance ?? '0' },
    { key: 'bonus', value: input.bonus ?? '0' },
    { key: 'fine', value: input.fine ?? '0' },
    { key: 'loanDeduction', value: input.loanDeduction ?? '0' },
  ] as const
  const parsed = fields.map((f) => {
    const raw = f.value === '' ? '0' : f.value
    return parseDecimal(raw, f.key, true, false)
  })
  const workdays = parsed[0]!
  const overtimeHours = parsed[1]!
  const dailyWage = parsed[2]!
  const allowance = parsed[3]!
  const bonus = parsed[4]!
  const fine = parsed[5]!
  const loanDeduction = parsed[6]!
  const baseAmount = decimal(roundAmount(workdays.mul(dailyWage)))
  const payable = baseAmount.add(allowance).add(bonus).sub(fine).sub(loanDeduction)
  return {
    employeeId: input.employeeId,
    month: input.month,
    workdays: toDecimalString(workdays),
    attendanceDays,
    missingDays,
    overtimeHours: toDecimalString(overtimeHours),
    dailyWage: toDecimalString(dailyWage),
    baseAmount: toDecimalString(baseAmount),
    allowance: toDecimalString(allowance),
    bonus: toDecimalString(bonus),
    fine: toDecimalString(fine),
    loanDeduction: toDecimalString(loanDeduction),
    payable: toDecimalString(payable),
    remarks: input.remarks ?? null,
  }
}

function normalizeLoanInput(kindRaw: string, occurredOn: string, amountRaw: string) {
  const kind = lowerWire(kindRaw)
  if (kind !== LOAN_BORROW && kind !== LOAN_REPAY) {
    throw ApiError.validation('员工借款参数不合法', { kind: ['必须是 BORROW 或 REPAY'] })
  }
  const date = parseDate(occurredOn, 'occurredOn')
  const amount = parseDecimal(amountRaw, 'amount', false, false)
  if (!amount.gt(0)) {
    throw ApiError.validation('员工借款参数不合法', { amount: ['必须大于零'] })
  }
  return { kind, occurredOn: date, amount }
}

function validateCorrectionInput(dateValue: string, values: string[]) {
  const date = parseDate(dateValue, 'date')
  if (values.length < 1 || values.length > 20) {
    throw ApiError.validation('补卡参数不合法', { times: ['必须包含 1 到 20 个时刻'] })
  }
  const seen = new Set<string>()
  for (const raw of values) {
    if (!/^[0-2]\d:[0-5]\d:[0-5]\d$/.test(raw)) {
      throw ApiError.validation('补卡参数不合法', { times: ['格式应为 HH:MM:SS'] })
    }
    // 规范校验时钟
    const [h, m, s] = raw.split(':').map(Number)
    if ((h ?? 0) > 23) {
      throw ApiError.validation('补卡参数不合法', { times: ['格式应为 HH:MM:SS'] })
    }
    void m
    void s
    seen.add(raw)
  }
  const times = [...seen].sort()
  return { date: asDateOnly(date), times }
}

function validateCorrectionNote(value: string | null | undefined) {
  if (value != null && [...value].length > 200) {
    throw ApiError.validation('补卡参数不合法', { note: ['最多 200 个字符'] })
  }
}

async function loadEmployeeMap(
  handle: DbHandle,
  rows: ParsedPunch[],
): Promise<Map<string, string>> {
  const nos = [...new Set(rows.map((r) => r.attendanceNo))]
  const result = new Map<string, string>()
  if (nos.length === 0) return result
  const found = await sql<{ attendance_no: string; id: string }>`
    SELECT attendance_no, id FROM hr_employees
     WHERE attendance_no = ANY(${nos}::text[])
  `.execute(handle)
  for (const r of found.rows) result.set(r.attendance_no, r.id)
  return result
}

function missingAttendanceNos(rows: ParsedPunch[], employees: Map<string, string>): string[] {
  const set = new Set<string>()
  for (const row of rows) {
    if (!employees.has(row.attendanceNo)) set.add(row.attendanceNo)
  }
  return [...set].sort()
}

async function recomputePairs(handle: DbHandle, pairs: AttendancePair[]): Promise<void> {
  const ordered = [...pairs].sort((a, b) => {
    if (a.employeeId === b.employeeId) return a.date.localeCompare(b.date)
    return a.employeeId.localeCompare(b.employeeId)
  })
  for (const pair of ordered) await recomputePair(handle, pair)
}

async function recomputePair(handle: DbHandle, pair: AttendancePair): Promise<void> {
  const startMs = Date.parse(`${pair.date}T00:00:00Z`) - ATTENDANCE_UTC_OFFSET_MS
  const start = new Date(startMs)
  const end = new Date(startMs + 24 * 60 * 60 * 1000)
  const rows = await sql<{ local_time: string }>`
    SELECT to_char(local_time,'HH24:MI:SS') AS local_time FROM (
      SELECT (punched_at + interval ${sql.raw(`'${ATTENDANCE_OFFSET_INTERVAL}'`)})::time AS local_time
        FROM hr_attendance_punch
       WHERE employee_id = ${pair.employeeId}::uuid
         AND punched_at >= ${tsParam(start)}
         AND punched_at < ${tsParam(end)}
      UNION ALL
      SELECT unnest(times) FROM hr_attendance_correction
       WHERE employee_id = ${pair.employeeId}::uuid AND date = ${pair.date}::date
    ) source_values
  `.execute(handle)
  const values = rows.rows.map((r) => r.local_time)
  if (values.length === 0) {
    try {
      await sql`
        DELETE FROM hr_attendance_day
         WHERE employee_id = ${pair.employeeId}::uuid AND date = ${pair.date}::date
      `.execute(handle)
    } catch (err) {
      throw writeErr(err, '清理日考勤失败')
    }
    return
  }
  let computed
  try {
    computed = computeAttendanceDay(values)
  } catch (err) {
    throw new ApiError('internal', '解析日考勤时刻失败', { cause: err })
  }
  try {
    await sql`
      INSERT INTO hr_attendance_day(
        date, morning_in, morning_out, afternoon_in, afternoon_out,
        normal_hours, overtime_hours, bonus_workday, status, employee_id)
      VALUES (
        ${pair.date}::date,
        ${computed.morningIn}::time,
        ${computed.morningOut}::time,
        ${computed.afternoonIn}::time,
        ${computed.afternoonOut}::time,
        ${computed.normalHours}::numeric,
        ${computed.overtimeHours}::numeric,
        ${computed.bonusWorkday}::numeric,
        ${computed.status},
        ${pair.employeeId}::uuid
      )
      ON CONFLICT (employee_id, date) DO UPDATE SET
        morning_in = excluded.morning_in,
        morning_out = excluded.morning_out,
        afternoon_in = excluded.afternoon_in,
        afternoon_out = excluded.afternoon_out,
        normal_hours = excluded.normal_hours,
        overtime_hours = excluded.overtime_hours,
        bonus_workday = excluded.bonus_workday,
        status = excluded.status,
        updated_at = (now() AT TIME ZONE 'utc')
    `.execute(handle)
  } catch (err) {
    throw writeErr(err, '写入日考勤失败')
  }
}

// ── row mappers ──────────────────────────────────────────────────────────────

function mapPunchRow(r: Record<string, unknown>): AttendancePunch {
  return {
    id: String(r.id),
    attendanceNo: String(r.attendance_no),
    // punched_at/inserted_at 已由 SQL to_char 格式化为 UTC 墙钟 ISO
    punchedAt: asUtcIsoDate(r.punched_at as Date | string),
    insertedAt: asUtcIsoDate(r.inserted_at as Date | string),
    employeeId: String(r.employee_id),
    importId: String(r.import_id),
  }
}

/** 将 UTC 墙钟 ISO 或 Date 规范为 Date（按 UTC 瞬时） */
function asUtcIsoDate(value: Date | string): Date {
  if (value instanceof Date) return value
  const s = String(value)
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return new Date(s)
  return new Date(s.includes('T') ? `${s}Z` : `${s.replace(' ', 'T')}Z`)
}

function mapImportRow(r: Record<string, unknown>): AttendanceImport {
  return {
    id: String(r.id),
    status: upperWire(String(r.status)),
    error: r.error == null ? null : String(r.error),
    totalRows: r.total_rows == null ? null : Number(r.total_rows),
    badRows: r.bad_rows == null ? null : Number(r.bad_rows),
    dupRows: r.dup_rows == null ? null : Number(r.dup_rows),
    matchedRows: r.matched_rows == null ? null : Number(r.matched_rows),
    unmatchedRows: r.unmatched_rows == null ? null : Number(r.unmatched_rows),
    unmatchedDetail: r.unmatched_detail == null ? null : String(r.unmatched_detail),
    importedCount: r.imported_count == null ? null : Number(r.imported_count),
    skippedExistingRows:
      r.skipped_existing_rows == null ? null : Number(r.skipped_existing_rows),
    skippedUnmatchedRows:
      r.skipped_unmatched_rows == null ? null : Number(r.skipped_unmatched_rows),
    autoCreatedCount: r.auto_created_count == null ? null : Number(r.auto_created_count),
    importedAt: r.imported_at == null ? null : asDate(r.imported_at as Date | string),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    fileId: String(r.file_id),
    createdById: r.created_by_id == null ? null : String(r.created_by_id),
    importedById: r.imported_by_id == null ? null : String(r.imported_by_id),
    punchCount: Number(r.punch_count ?? 0),
  }
}

function mapDayRow(r: Record<string, unknown>): AttendanceDay {
  return {
    id: String(r.id),
    date: asDateOnly(r.date as Date | string),
    morningIn: r.morning_in == null ? null : String(r.morning_in),
    morningOut: r.morning_out == null ? null : String(r.morning_out),
    afternoonIn: r.afternoon_in == null ? null : String(r.afternoon_in),
    afternoonOut: r.afternoon_out == null ? null : String(r.afternoon_out),
    normalHours: numStr(r.normal_hours),
    overtimeHours: numStr(r.overtime_hours),
    bonusWorkday: numStr(r.bonus_workday),
    status: upperWire(String(r.status)),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    employeeId: String(r.employee_id),
  }
}

function mapCorrectionRow(r: Record<string, unknown>): AttendanceCorrection {
  const times = Array.isArray(r.times) ? (r.times as string[]).map(String) : []
  return {
    id: String(r.id),
    date: asDateOnly(r.date as Date | string),
    times,
    note: r.note == null ? null : String(r.note),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    employeeId: String(r.employee_id),
    createdById: r.created_by_id == null ? null : String(r.created_by_id),
  }
}

function mapPayrollRow(r: Record<string, unknown>): Payroll {
  return {
    id: String(r.id),
    month: String(r.month),
    workdays: numStr(r.workdays),
    attendanceDays: Number(r.attendance_days),
    missingDays: Number(r.missing_days),
    overtimeHours: numStr(r.overtime_hours),
    dailyWage: numStr(r.daily_wage),
    baseAmount: numStr(r.base_amount),
    allowance: numStr(r.allowance),
    bonus: numStr(r.bonus),
    fine: numStr(r.fine),
    loanDeduction: numStr(r.loan_deduction),
    payable: numStr(r.payable),
    status: upperWire(String(r.status)),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    employeeId: String(r.employee_id),
    paidTotal: nullableNumStr(r.paid_total),
  }
}

function mapPaymentRow(r: Record<string, unknown>): PayrollPayment {
  return {
    id: String(r.id),
    month: r.month == null ? null : String(r.month),
    paidOn: asDateOnly(r.paid_on as Date | string),
    amount: numStr(r.amount),
    kind: r.kind == null ? null : upperWire(String(r.kind)),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    payrollId: String(r.payroll_id),
    employeeId: r.employee_id == null ? null : String(r.employee_id),
    createdById: r.created_by_id == null ? null : String(r.created_by_id),
  }
}

function mapLoanRow(r: Record<string, unknown>): EmployeeLoan {
  return {
    id: String(r.id),
    kind: upperWire(String(r.kind)),
    occurredOn: asDateOnly(r.occurred_on as Date | string),
    amount: numStr(r.amount),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: asDate(r.inserted_at as Date | string),
    updatedAt: asDate(r.updated_at as Date | string),
    employeeId: String(r.employee_id),
    payrollId: r.payroll_id == null ? null : String(r.payroll_id),
    createdById: r.created_by_id == null ? null : String(r.created_by_id),
  }
}

function importSnap(v: AttendanceImport): Record<string, unknown> {
  return {
    status: lowerWire(v.status),
    error: v.error,
    total_rows: v.totalRows,
    bad_rows: v.badRows,
    dup_rows: v.dupRows,
    matched_rows: v.matchedRows,
    unmatched_rows: v.unmatchedRows,
    unmatched_detail: v.unmatchedDetail,
    imported_count: v.importedCount,
    skipped_existing_rows: v.skippedExistingRows,
    skipped_unmatched_rows: v.skippedUnmatchedRows,
    auto_created_count: v.autoCreatedCount,
    imported_at: v.importedAt,
    file_id: v.fileId,
    created_by_id: v.createdById,
    imported_by_id: v.importedById,
  }
}

function correctionSnap(v: AttendanceCorrection): Record<string, unknown> {
  return {
    date: v.date,
    times: v.times,
    note: v.note,
    employee_id: v.employeeId,
    created_by_id: v.createdById,
  }
}

function payrollSnap(v: Payroll): Record<string, unknown> {
  return {
    month: v.month,
    workdays: v.workdays,
    attendance_days: v.attendanceDays,
    missing_days: v.missingDays,
    overtime_hours: v.overtimeHours,
    daily_wage: v.dailyWage,
    base_amount: v.baseAmount,
    allowance: v.allowance,
    bonus: v.bonus,
    fine: v.fine,
    loan_deduction: v.loanDeduction,
    payable: v.payable,
    status: lowerWire(v.status),
    remarks: v.remarks,
    employee_id: v.employeeId,
  }
}

function paymentSnap(v: PayrollPayment): Record<string, unknown> {
  return {
    month: v.month,
    paid_on: v.paidOn,
    amount: v.amount,
    kind: v.kind == null ? null : lowerWire(v.kind),
    remarks: v.remarks,
    payroll_id: v.payrollId,
    employee_id: v.employeeId,
    created_by_id: v.createdById,
  }
}

function loanSnap(v: EmployeeLoan): Record<string, unknown> {
  return {
    kind: lowerWire(v.kind),
    occurred_on: v.occurredOn,
    amount: v.amount,
    remarks: v.remarks,
    employee_id: v.employeeId,
    payroll_id: v.payrollId,
    created_by_id: v.createdById,
  }
}

// silence unused import if DAY_MISSING only used in rules tests
void DAY_MISSING
void toIso
