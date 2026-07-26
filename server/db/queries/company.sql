-- name: GetCompany :one
SELECT c.id, c.code, c.name, c.short_name, c.parent_id, c.base_currency_id,
       c.inserted_at, c.updated_at, p.name AS parent_name, currency.name AS base_currency_name
FROM bas_company AS c
LEFT JOIN bas_company AS p ON p.id = c.parent_id
JOIN bas_currency AS currency ON currency.id = c.base_currency_id
WHERE c.id = $1;

-- name: LockCompany :one
SELECT id, code, name, short_name, parent_id, base_currency_id, inserted_at, updated_at
FROM bas_company WHERE id = $1 FOR UPDATE;

-- name: CreateCompany :one
INSERT INTO bas_company (code, name, short_name, parent_id, base_currency_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING id;

-- name: UpdateCompany :exec
UPDATE bas_company
SET name = $2, short_name = $3, parent_id = $4, base_currency_id = $5,
    updated_at = timezone('utc', now())
WHERE id = $1;

-- name: DeleteCompany :execrows
DELETE FROM bas_company WHERE id = $1;

-- name: CurrencyIsActive :one
SELECT EXISTS (SELECT 1 FROM bas_currency WHERE id = $1 AND active = true);

-- name: CompanyParentLink :one
SELECT parent_id FROM bas_company WHERE id = $1;
