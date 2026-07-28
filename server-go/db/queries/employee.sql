-- name: GetEmployee :one
SELECT * FROM hr_employees WHERE id = $1;

-- name: LockEmployee :one
SELECT * FROM hr_employees WHERE id = $1 FOR UPDATE;

-- name: CreateEmployee :one
INSERT INTO hr_employees (
  code, name, attendance_no, id_number, household_registration, phone,
  current_address, daily_wage, monthly_allowance, insurance_types
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: UpdateEmployee :one
UPDATE hr_employees
SET code = $2,
    name = $3,
    attendance_no = $4,
    id_number = $5,
    household_registration = $6,
    phone = $7,
    current_address = $8,
    daily_wage = $9,
    monthly_allowance = $10,
    insurance_types = $11,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING *;

-- name: DeleteEmployee :execrows
DELETE FROM hr_employees WHERE id = $1;
