-- name: GetCurrency :one
SELECT id, name, iso_code, symbol, active, inserted_at, updated_at
FROM bas_currency
WHERE id = $1;

-- name: LockCurrency :one
SELECT id, name, iso_code, symbol, active, inserted_at, updated_at
FROM bas_currency
WHERE id = $1
FOR UPDATE;

-- name: CreateCurrency :one
INSERT INTO bas_currency (name, iso_code, symbol, active)
VALUES (sqlc.arg(name), sqlc.arg(iso_code), sqlc.narg(symbol), sqlc.arg(active))
RETURNING id, name, iso_code, symbol, active, inserted_at, updated_at;

-- name: UpdateCurrency :one
UPDATE bas_currency
SET name = sqlc.arg(name),
    symbol = sqlc.narg(symbol),
    active = sqlc.arg(active),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, name, iso_code, symbol, active, inserted_at, updated_at;

-- name: DeleteCurrency :execrows
DELETE FROM bas_currency
WHERE id = $1;

-- name: CurrencyIsCompanyBase :one
SELECT EXISTS (
  SELECT 1 FROM bas_company WHERE base_currency_id = $1
) AS referenced;
