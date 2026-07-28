-- name: GetStockCount :one
SELECT id, doc_no, posting_date, summary, remarks, status, audited_at,
       snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
       created_by_id, audited_by_id
FROM inv_stock_count
WHERE id = $1;

-- name: LockStockCount :one
SELECT id, doc_no, posting_date, summary, remarks, status, audited_at,
       snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
       created_by_id, audited_by_id
FROM inv_stock_count
WHERE id = $1
FOR UPDATE;

-- name: CreateStockCount :one
INSERT INTO inv_stock_count (
  doc_no, posting_date, summary, remarks, snapshot_taken_at,
  company_id, warehouse_id, created_by_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, doc_no, posting_date, summary, remarks, status, audited_at,
          snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
          created_by_id, audited_by_id;

-- name: UpdateStockCount :one
UPDATE inv_stock_count
SET doc_no = $2,
    posting_date = $3,
    summary = $4,
    remarks = $5,
    warehouse_id = $6,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, doc_no, posting_date, summary, remarks, status, audited_at,
          snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
          created_by_id, audited_by_id;

-- name: TouchStockCountSnapshot :one
UPDATE inv_stock_count
SET snapshot_taken_at = sqlc.arg(snapshot_taken_at),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, doc_no, posting_date, summary, remarks, status, audited_at,
          snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
          created_by_id, audited_by_id;

-- name: ApproveStockCount :one
UPDATE inv_stock_count
SET status = 'audited',
    audited_at = sqlc.arg(audited_at),
    audited_by_id = sqlc.narg(audited_by_id)::uuid,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, doc_no, posting_date, summary, remarks, status, audited_at,
          snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
          created_by_id, audited_by_id;

-- name: CancelStockCount :one
UPDATE inv_stock_count
SET status = 'cancelled',
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, doc_no, posting_date, summary, remarks, status, audited_at,
          snapshot_taken_at, inserted_at, updated_at, company_id, warehouse_id,
          created_by_id, audited_by_id;

-- name: DeleteStockCount :execrows
DELETE FROM inv_stock_count WHERE id = $1;

-- name: GetStockCountItem :one
SELECT id, counted_quantity, converted_counted, book_quantity, material_code,
       material_name, material_spec, unit_name, remark, inserted_at, updated_at,
       count_id, company_id, material_id, unit_id
FROM inv_stock_count_item
WHERE id = $1;

-- name: LockStockCountItem :one
SELECT id, counted_quantity, converted_counted, book_quantity, material_code,
       material_name, material_spec, unit_name, remark, inserted_at, updated_at,
       count_id, company_id, material_id, unit_id
FROM inv_stock_count_item
WHERE id = $1
FOR UPDATE;

-- name: ListStockCountItems :many
SELECT id, counted_quantity, converted_counted, book_quantity, material_code,
       material_name, material_spec, unit_name, remark, inserted_at, updated_at,
       count_id, company_id, material_id, unit_id
FROM inv_stock_count_item
WHERE count_id = $1
ORDER BY material_code ASC, id ASC;

-- name: GetStockCountItemProjection :one
SELECT m.code AS material_code,
       m.name AS material_name,
       m.spec AS material_spec,
       m.default_unit_id,
       u.name AS unit_name,
       mu.factor AS conversion_factor,
       COALESCE((
         SELECT sum(e.quantity)
         FROM inv_stock_entry AS e
         WHERE e.warehouse_id = sqlc.arg(warehouse_id)
           AND e.material_id = m.id
           AND e.is_cancelled = false
       ), 0)::numeric AS book_quantity
FROM inv_material AS m
JOIN bas_unit AS u ON u.id = sqlc.arg(unit_id)
LEFT JOIN inv_material_unit AS mu
  ON mu.material_id = m.id
 AND mu.unit_id = sqlc.arg(unit_id)
WHERE m.id = sqlc.arg(material_id);

-- name: ListStockCountLoadAllProjection :many
SELECT m.id AS material_id,
       m.code AS material_code,
       m.name AS material_name,
       m.spec AS material_spec,
       m.default_unit_id AS unit_id,
       u.name AS unit_name,
       sum(e.quantity)::numeric AS book_quantity
FROM inv_stock_entry AS e
JOIN inv_material AS m ON m.id = e.material_id
JOIN bas_unit AS u ON u.id = m.default_unit_id
WHERE e.company_id = sqlc.arg(company_id)
  AND e.warehouse_id = sqlc.arg(warehouse_id)
  AND e.is_cancelled = false
GROUP BY m.id, m.code, m.name, m.spec, m.default_unit_id, u.name
HAVING sum(e.quantity) <> 0
ORDER BY m.code ASC, m.id ASC;

-- name: CreateStockCountItem :one
INSERT INTO inv_stock_count_item (
  counted_quantity, converted_counted, book_quantity, material_code,
  material_name, material_spec, unit_name, remark, count_id, company_id,
  material_id, unit_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id, counted_quantity, converted_counted, book_quantity, material_code,
          material_name, material_spec, unit_name, remark, inserted_at, updated_at,
          count_id, company_id, material_id, unit_id;

-- name: UpdateStockCountItem :one
UPDATE inv_stock_count_item
SET counted_quantity = $2,
    converted_counted = $3,
    book_quantity = $4,
    material_code = $5,
    material_name = $6,
    material_spec = $7,
    unit_name = $8,
    remark = $9,
    material_id = $10,
    unit_id = $11,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, counted_quantity, converted_counted, book_quantity, material_code,
          material_name, material_spec, unit_name, remark, inserted_at, updated_at,
          count_id, company_id, material_id, unit_id;

-- name: SyncStockCountItemBookQuantity :one
UPDATE inv_stock_count_item
SET book_quantity = $2,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, counted_quantity, converted_counted, book_quantity, material_code,
          material_name, material_spec, unit_name, remark, inserted_at, updated_at,
          count_id, company_id, material_id, unit_id;

-- name: DeleteStockCountItem :execrows
DELETE FROM inv_stock_count_item WHERE id = $1;

-- name: StockCountSnapshotIsStale :one
SELECT EXISTS(
  SELECT 1
  FROM inv_stock_entry
  WHERE company_id = sqlc.arg(company_id)
    AND warehouse_id = sqlc.arg(warehouse_id)
    AND (
      inserted_at > sqlc.arg(snapshot_taken_at)
      OR cancelled_at > sqlc.arg(snapshot_taken_at)
    )
);
