-- name: GetWarehouse :one
SELECT id, name, is_leaf, active, is_outsourced, allow_negative,
       inserted_at, updated_at, company_id, parent_id, account_id, party_type, party_id
FROM inv_warehouse
WHERE id = $1;

-- name: LockWarehouse :one
SELECT id, name, is_leaf, active, is_outsourced, allow_negative,
       inserted_at, updated_at, company_id, parent_id, account_id, party_type, party_id
FROM inv_warehouse
WHERE id = $1
FOR UPDATE;

-- name: CreateWarehouse :one
INSERT INTO inv_warehouse (
  name, is_leaf, active, is_outsourced, allow_negative,
  company_id, parent_id, account_id, party_type, party_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, name, is_leaf, active, is_outsourced, allow_negative,
          inserted_at, updated_at, company_id, parent_id, account_id, party_type, party_id;

-- name: UpdateWarehouse :one
UPDATE inv_warehouse
SET name = $2,
    is_leaf = $3,
    active = $4,
    is_outsourced = $5,
    allow_negative = $6,
    parent_id = $7,
    account_id = $8,
    party_type = $9,
    party_id = $10,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, name, is_leaf, active, is_outsourced, allow_negative,
          inserted_at, updated_at, company_id, parent_id, account_id, party_type, party_id;

-- name: WarehouseHasChildren :one
SELECT EXISTS(SELECT 1 FROM inv_warehouse WHERE parent_id = $1);

-- name: WarehouseHasStockEntries :one
SELECT EXISTS(SELECT 1 FROM inv_stock_entry WHERE warehouse_id = $1);

-- name: DeleteWarehouse :exec
DELETE FROM inv_warehouse WHERE id = $1;
