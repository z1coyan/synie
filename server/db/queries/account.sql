-- name: GetAccount :one
SELECT a.id, a.code, a.name, a.direction, a.is_group, a.active, a.role,
       a.parent_id, a.company_id, a.currency_id, a.inserted_at, a.updated_at,
       p.name AS parent_name, company.name AS company_name, currency.name AS currency_name,
       EXISTS(SELECT 1 FROM bas_account child WHERE child.parent_id = a.id) AS has_children
FROM bas_account AS a
LEFT JOIN bas_account AS p ON p.id = a.parent_id
JOIN bas_company AS company ON company.id = a.company_id
LEFT JOIN bas_currency AS currency ON currency.id = a.currency_id
WHERE a.id = $1;

-- name: LockAccount :one
SELECT id, code, name, direction, is_group, active, role,
       parent_id, company_id, currency_id, inserted_at, updated_at
FROM bas_account
WHERE id = $1
FOR UPDATE;

-- name: CreateAccount :one
INSERT INTO bas_account (
  code, name, direction, is_group, active, role, parent_id, company_id, currency_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, code, name, direction, is_group, active, role,
          parent_id, company_id, currency_id, inserted_at, updated_at;

-- name: UpdateAccount :one
UPDATE bas_account
SET name = $2, direction = $3, is_group = $4, active = $5, role = $6,
    parent_id = $7, currency_id = $8, updated_at = timezone('utc', now())
WHERE id = $1
RETURNING id, code, name, direction, is_group, active, role,
          parent_id, company_id, currency_id, inserted_at, updated_at;

-- name: DeleteAccount :execrows
DELETE FROM bas_account WHERE id = $1;

-- name: AccountParentCompany :one
SELECT company_id FROM bas_account WHERE id = $1;

-- name: AccountHasChildren :one
SELECT EXISTS(SELECT 1 FROM bas_account WHERE parent_id = $1);

-- name: AccountCountByCompany :one
SELECT count(*) FROM bas_account WHERE company_id = $1;

-- name: AccountCurrencyISOCode :one
SELECT iso_code FROM bas_currency WHERE id = $1;
