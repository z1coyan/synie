-- name: GetHrAttendancePunch :one
SELECT * FROM hr_attendance_punch WHERE id = $1;

-- name: GetHrAttendanceImport :one
SELECT * FROM hr_attendance_import WHERE id = $1;

-- name: LockHrAttendanceImport :one
SELECT * FROM hr_attendance_import WHERE id = $1 FOR UPDATE;

-- name: CreateHrAttendanceImport :one
INSERT INTO hr_attendance_import (
  status, error, total_rows, bad_rows, dup_rows, matched_rows, unmatched_rows,
  unmatched_detail, file_id, created_by_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
RETURNING *;

-- name: ImportHrAttendanceBatch :one
UPDATE hr_attendance_import SET
  status = 'imported', imported_count = $2, skipped_existing_rows = $3,
  skipped_unmatched_rows = $4, auto_created_count = $5, imported_at = $6,
  imported_by_id = $7, updated_at = $6
WHERE id = $1
RETURNING *;

-- name: DeleteHrAttendanceImport :exec
DELETE FROM hr_attendance_import WHERE id = $1;

-- name: GetHrAttendanceDay :one
SELECT * FROM hr_attendance_day WHERE id = $1;

-- name: UpsertHrAttendanceDay :one
INSERT INTO hr_attendance_day (
  date, morning_in, morning_out, afternoon_in, afternoon_out, normal_hours,
  overtime_hours, bonus_workday, status, employee_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
ON CONFLICT (employee_id,date) DO UPDATE SET
  morning_in=excluded.morning_in, morning_out=excluded.morning_out,
  afternoon_in=excluded.afternoon_in, afternoon_out=excluded.afternoon_out,
  normal_hours=excluded.normal_hours, overtime_hours=excluded.overtime_hours,
  bonus_workday=excluded.bonus_workday, status=excluded.status,
  updated_at=(now() AT TIME ZONE 'utc')
RETURNING *;

-- name: DeleteHrAttendanceDayByPair :exec
DELETE FROM hr_attendance_day WHERE employee_id=$1 AND date=$2;

-- name: GetHrAttendanceCorrection :one
SELECT * FROM hr_attendance_correction WHERE id = $1;

-- name: LockHrAttendanceCorrection :one
SELECT * FROM hr_attendance_correction WHERE id = $1 FOR UPDATE;

-- name: CreateHrAttendanceCorrection :one
INSERT INTO hr_attendance_correction (
  date,times,note,employee_id,created_by_id
) VALUES ($1,$2,$3,$4,$5)
RETURNING *;

-- name: DeleteHrAttendanceCorrection :exec
DELETE FROM hr_attendance_correction WHERE id = $1;

-- name: GetHrPayroll :one
SELECT * FROM hr_payroll WHERE id = $1;

-- name: LockHrPayroll :one
SELECT * FROM hr_payroll WHERE id = $1 FOR UPDATE;

-- name: CreateHrPayroll :one
INSERT INTO hr_payroll (
  month,workdays,attendance_days,missing_days,overtime_hours,daily_wage,
  base_amount,allowance,bonus,fine,loan_deduction,payable,remarks,employee_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
RETURNING *;

-- name: DeleteHrPayroll :exec
DELETE FROM hr_payroll WHERE id = $1;

-- name: GetHrPayrollPayment :one
SELECT * FROM hr_payroll_payment WHERE id = $1;

-- name: LockHrPayrollPayment :one
SELECT * FROM hr_payroll_payment WHERE id = $1 FOR UPDATE;

-- name: CreateHrPayrollPayment :one
INSERT INTO hr_payroll_payment (
  month,paid_on,amount,kind,remarks,payroll_id,employee_id,created_by_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
RETURNING *;

-- name: DeleteHrPayrollPayment :exec
DELETE FROM hr_payroll_payment WHERE id = $1;

-- name: GetHrEmployeeLoan :one
SELECT * FROM hr_employee_loan WHERE id = $1;

-- name: LockHrEmployeeLoan :one
SELECT * FROM hr_employee_loan WHERE id = $1 FOR UPDATE;

-- name: CreateHrEmployeeLoan :one
INSERT INTO hr_employee_loan (
  kind,occurred_on,amount,remarks,employee_id,payroll_id,created_by_id
) VALUES ($1,$2,$3,$4,$5,$6,$7)
RETURNING *;

-- name: DeleteHrEmployeeLoan :exec
DELETE FROM hr_employee_loan WHERE id = $1;
