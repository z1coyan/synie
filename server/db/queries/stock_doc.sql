-- name: GetStockDoc :one
SELECT id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
       inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id
FROM inv_stock_doc
WHERE id = $1;

-- name: LockStockDoc :one
SELECT id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
       inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id
FROM inv_stock_doc
WHERE id = $1
FOR UPDATE;

-- name: CountStockDocs :one
SELECT count(*)
FROM inv_stock_doc
WHERE (sqlc.arg(scope_bypass)::boolean OR company_id = ANY(sqlc.arg(company_ids)::uuid[]));

-- name: ListStockDocs :many
SELECT id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
       inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id
FROM inv_stock_doc
WHERE (sqlc.arg(scope_bypass)::boolean OR company_id = ANY(sqlc.arg(company_ids)::uuid[]))
ORDER BY doc_no ASC, id ASC
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: CreateStockDoc :one
INSERT INTO inv_stock_doc (
  doc_no, direction, doc_date, summary, remarks, company_id, warehouse_id, created_by_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
          inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id;

-- name: UpdateStockDoc :one
UPDATE inv_stock_doc
SET doc_no = $2,
    doc_date = $3,
    summary = $4,
    remarks = $5,
    warehouse_id = $6,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
          inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id;

-- name: AuditStockDoc :one
UPDATE inv_stock_doc
SET status = 'audited',
    audited_at = sqlc.arg(audited_at),
    audited_by_id = sqlc.narg(audited_by_id)::uuid,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
          inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id;

-- name: VoidStockDoc :one
UPDATE inv_stock_doc
SET status = 'voided',
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, doc_no, direction, doc_date, summary, remarks, status, audited_at,
          inserted_at, updated_at, company_id, warehouse_id, created_by_id, audited_by_id;

-- name: DeleteStockDoc :execrows
DELETE FROM inv_stock_doc WHERE id = $1;

-- name: StockDocHasItems :one
SELECT EXISTS(SELECT 1 FROM inv_stock_doc_item WHERE stock_doc_id = $1);

-- name: GetStockDocItem :one
SELECT id, idx, qty, base_qty, material_code, material_name, material_spec, unit_name,
       remark, inserted_at, updated_at, stock_doc_id, company_id, material_id, unit_id
FROM inv_stock_doc_item
WHERE id = $1;

-- name: LockStockDocItem :one
SELECT id, idx, qty, base_qty, material_code, material_name, material_spec, unit_name,
       remark, inserted_at, updated_at, stock_doc_id, company_id, material_id, unit_id
FROM inv_stock_doc_item
WHERE id = $1
FOR UPDATE;

-- name: ListStockDocItems :many
SELECT id, idx, qty, base_qty, material_code, material_name, material_spec, unit_name,
       remark, inserted_at, updated_at, stock_doc_id, company_id, material_id, unit_id
FROM inv_stock_doc_item
WHERE stock_doc_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetStockItemProjection :one
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

-- name: CreateStockDocItem :one
INSERT INTO inv_stock_doc_item (
  idx, qty, base_qty, material_code, material_name, material_spec, unit_name, remark,
  stock_doc_id, company_id, material_id, unit_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id, idx, qty, base_qty, material_code, material_name, material_spec, unit_name,
          remark, inserted_at, updated_at, stock_doc_id, company_id, material_id, unit_id;

-- name: UpdateStockDocItem :one
UPDATE inv_stock_doc_item
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
RETURNING id, idx, qty, base_qty, material_code, material_name, material_spec, unit_name,
          remark, inserted_at, updated_at, stock_doc_id, company_id, material_id, unit_id;

-- name: DeleteStockDocItem :execrows
DELETE FROM inv_stock_doc_item WHERE id = $1;
