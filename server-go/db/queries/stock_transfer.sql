-- name: GetStockTransfer :one
SELECT id, doc_no, doc_date, summary, remarks, status, shipped_at, received_at,
       inserted_at, updated_at, company_id, from_warehouse_id, to_warehouse_id,
       transit_warehouse_id, created_by_id, shipped_by_id, received_by_id
FROM inv_stock_transfer
WHERE id = $1;

-- name: LockStockTransfer :one
SELECT id, doc_no, doc_date, summary, remarks, status, shipped_at, received_at,
       inserted_at, updated_at, company_id, from_warehouse_id, to_warehouse_id,
       transit_warehouse_id, created_by_id, shipped_by_id, received_by_id
FROM inv_stock_transfer
WHERE id = $1
FOR UPDATE;

-- name: CreateStockTransfer :one
INSERT INTO inv_stock_transfer (
  doc_no, doc_date, summary, remarks, company_id, from_warehouse_id,
  to_warehouse_id, transit_warehouse_id, created_by_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, doc_no, doc_date, summary, remarks, status, shipped_at, received_at,
          inserted_at, updated_at, company_id, from_warehouse_id, to_warehouse_id,
          transit_warehouse_id, created_by_id, shipped_by_id, received_by_id;

-- name: UpdateStockTransfer :one
UPDATE inv_stock_transfer
SET doc_no = $2,
    doc_date = $3,
    summary = $4,
    remarks = $5,
    from_warehouse_id = $6,
    to_warehouse_id = $7,
    transit_warehouse_id = $8,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, doc_no, doc_date, summary, remarks, status, shipped_at, received_at,
          inserted_at, updated_at, company_id, from_warehouse_id, to_warehouse_id,
          transit_warehouse_id, created_by_id, shipped_by_id, received_by_id;

-- name: ShipStockTransfer :one
UPDATE inv_stock_transfer
SET status = 'shipped',
    shipped_at = sqlc.arg(shipped_at),
    shipped_by_id = sqlc.narg(shipped_by_id)::uuid,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, doc_no, doc_date, summary, remarks, status, shipped_at, received_at,
          inserted_at, updated_at, company_id, from_warehouse_id, to_warehouse_id,
          transit_warehouse_id, created_by_id, shipped_by_id, received_by_id;

-- name: ReceiveStockTransfer :one
UPDATE inv_stock_transfer
SET status = 'received',
    received_at = sqlc.arg(received_at),
    received_by_id = sqlc.narg(received_by_id)::uuid,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, doc_no, doc_date, summary, remarks, status, shipped_at, received_at,
          inserted_at, updated_at, company_id, from_warehouse_id, to_warehouse_id,
          transit_warehouse_id, created_by_id, shipped_by_id, received_by_id;

-- name: DeleteStockTransfer :execrows
DELETE FROM inv_stock_transfer WHERE id = $1;

-- name: GetStockTransferItem :one
SELECT id, idx, qty, base_qty, received_qty, material_code, material_name,
       material_spec, unit_name, remark, inserted_at, updated_at,
       stock_transfer_id, company_id, material_id, unit_id
FROM inv_stock_transfer_item
WHERE id = $1;

-- name: LockStockTransferItem :one
SELECT id, idx, qty, base_qty, received_qty, material_code, material_name,
       material_spec, unit_name, remark, inserted_at, updated_at,
       stock_transfer_id, company_id, material_id, unit_id
FROM inv_stock_transfer_item
WHERE id = $1
FOR UPDATE;

-- name: ListStockTransferItems :many
SELECT id, idx, qty, base_qty, received_qty, material_code, material_name,
       material_spec, unit_name, remark, inserted_at, updated_at,
       stock_transfer_id, company_id, material_id, unit_id
FROM inv_stock_transfer_item
WHERE stock_transfer_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetStockTransferItemProjection :one
SELECT m.code AS material_code,
       m.name AS material_name,
       m.spec AS material_spec,
       m.default_unit_id,
       u.name AS unit_name,
       mu.factor AS conversion_factor
FROM inv_material AS m
JOIN bas_unit AS u ON u.id = sqlc.arg(unit_id)
LEFT JOIN inv_material_unit AS mu
  ON mu.material_id = m.id
 AND mu.unit_id = sqlc.arg(unit_id)
WHERE m.id = sqlc.arg(material_id);

-- name: CreateStockTransferItem :one
INSERT INTO inv_stock_transfer_item (
  idx, qty, base_qty, material_code, material_name, material_spec, unit_name,
  remark, stock_transfer_id, company_id, material_id, unit_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id, idx, qty, base_qty, received_qty, material_code, material_name,
          material_spec, unit_name, remark, inserted_at, updated_at,
          stock_transfer_id, company_id, material_id, unit_id;

-- name: UpdateStockTransferItem :one
UPDATE inv_stock_transfer_item
SET idx = $2,
    qty = $3,
    base_qty = $4,
    material_code = $5,
    material_name = $6,
    material_spec = $7,
    unit_name = $8,
    remark = $9,
    material_id = $10,
    unit_id = $11,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, idx, qty, base_qty, received_qty, material_code, material_name,
          material_spec, unit_name, remark, inserted_at, updated_at,
          stock_transfer_id, company_id, material_id, unit_id;

-- name: WriteStockTransferItemReceivedQty :one
UPDATE inv_stock_transfer_item
SET received_qty = $2,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, idx, qty, base_qty, received_qty, material_code, material_name,
          material_spec, unit_name, remark, inserted_at, updated_at,
          stock_transfer_id, company_id, material_id, unit_id;

-- name: DeleteStockTransferItem :execrows
DELETE FROM inv_stock_transfer_item WHERE id = $1;
