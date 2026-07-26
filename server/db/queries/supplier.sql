-- name: GetSupplier :one
SELECT * FROM pur_supplier WHERE id = $1;

-- name: LockSupplier :one
SELECT * FROM pur_supplier WHERE id = $1 FOR UPDATE;

-- name: CreateSupplier :one
INSERT INTO pur_supplier (code, name, short_name)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateSupplier :one
UPDATE pur_supplier
SET code = $2,
    name = $3,
    short_name = $4,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING *;

-- name: DeleteSupplier :execrows
DELETE FROM pur_supplier WHERE id = $1;
