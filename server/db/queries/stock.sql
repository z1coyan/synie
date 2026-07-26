-- name: LockStockBalanceKey :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key)::text, 0));

-- name: GetStockWarehouses :many
SELECT id, name, company_id, is_leaf, active, allow_negative
FROM inv_warehouse
WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: GetStockMaterials :many
SELECT id, code, name, spec, default_unit_id
FROM inv_material
WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: CurrentStockBalance :one
SELECT COALESCE(sum(quantity), 0)::numeric
FROM inv_stock_entry
WHERE warehouse_id = $1
  AND material_id = $2
  AND is_cancelled = false;

-- name: InsertStockEntry :one
INSERT INTO inv_stock_entry (
  company_id, warehouse_id, material_id, quantity, posting_date,
  voucher_type, voucher_id, voucher_no, remarks
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, seq, quantity, posting_date, voucher_type, voucher_id, voucher_no,
          is_cancelled, cancelled_at, remarks, inserted_at,
          company_id, warehouse_id, material_id;

-- name: ListLiveStockEntriesForVoucher :many
SELECT id, seq, quantity, posting_date, voucher_type, voucher_id, voucher_no,
       is_cancelled, cancelled_at, remarks, inserted_at,
       company_id, warehouse_id, material_id
FROM inv_stock_entry
WHERE voucher_type = $1
  AND voucher_id = $2
  AND is_cancelled = false
ORDER BY seq ASC;

-- name: CancelStockEntriesForVoucher :execrows
UPDATE inv_stock_entry
SET is_cancelled = true,
    cancelled_at = $3
WHERE voucher_type = $1
  AND voucher_id = $2
  AND is_cancelled = false;

-- name: StockBalance :many
SELECT e.warehouse_id,
       w.name AS warehouse_name,
       e.material_id,
       m.code AS material_code,
       m.name AS material_name,
       m.spec AS material_spec,
       u.name AS unit_name,
       sum(e.quantity)::numeric AS quantity
FROM inv_stock_entry AS e
JOIN inv_warehouse AS w ON w.id = e.warehouse_id
JOIN inv_material AS m ON m.id = e.material_id
JOIN bas_unit AS u ON u.id = m.default_unit_id
WHERE e.company_id = sqlc.arg(company_id)
  AND e.is_cancelled = false
  AND e.posting_date <= sqlc.arg(as_of)
  AND (sqlc.narg(warehouse_id)::uuid IS NULL OR e.warehouse_id = sqlc.narg(warehouse_id))
  AND (sqlc.narg(material_id)::uuid IS NULL OR e.material_id = sqlc.narg(material_id))
GROUP BY e.warehouse_id, w.name, e.material_id, m.code, m.name, m.spec, u.name
HAVING (NOT sqlc.arg(hide_zero)::boolean OR sum(e.quantity) <> 0)
ORDER BY w.name ASC, m.code ASC, e.warehouse_id ASC, e.material_id ASC;
