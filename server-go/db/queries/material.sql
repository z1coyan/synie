-- name: GetMaterial :one
SELECT id, code, name, spec, customer_part_no, active, inserted_at, updated_at,
       category_id, default_unit_id, is_customer_material, customer_id
FROM inv_material
WHERE id = $1;

-- name: LockMaterial :one
SELECT id, code, name, spec, customer_part_no, active, inserted_at, updated_at,
       category_id, default_unit_id, is_customer_material, customer_id
FROM inv_material
WHERE id = $1
FOR UPDATE;

-- name: CreateMaterial :one
INSERT INTO inv_material (
  code, name, spec, customer_part_no, active,
  category_id, default_unit_id, is_customer_material, customer_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, code, name, spec, customer_part_no, active, inserted_at, updated_at,
          category_id, default_unit_id, is_customer_material, customer_id;

-- name: UpdateMaterial :one
UPDATE inv_material
SET name = $2,
    spec = $3,
    customer_part_no = $4,
    active = $5,
    category_id = $6,
    default_unit_id = $7,
    is_customer_material = $8,
    customer_id = $9,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, code, name, spec, customer_part_no, active, inserted_at, updated_at,
          category_id, default_unit_id, is_customer_material, customer_id;

-- name: MaterialHasUnits :one
SELECT EXISTS(SELECT 1 FROM inv_material_unit WHERE material_id = $1);

-- name: MaterialHasStockEntries :one
SELECT EXISTS(SELECT 1 FROM inv_stock_entry WHERE material_id = $1);

-- name: MaterialHasSalesReferences :one
SELECT EXISTS(
  SELECT 1 FROM sal_order_item soi
  WHERE soi.material_id = sqlc.arg(material_id)::uuid
  UNION ALL
  SELECT 1 FROM sal_quotation_item sqi
  WHERE sqi.material_id = sqlc.arg(material_id)::uuid
);

-- name: DeleteMaterial :exec
DELETE FROM inv_material WHERE id = $1;
