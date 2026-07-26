-- name: GetStockEntry :one
SELECT id, seq, quantity, posting_date, voucher_type, voucher_id, voucher_no,
       is_cancelled, cancelled_at, remarks, inserted_at,
       company_id, warehouse_id, material_id
FROM inv_stock_entry
WHERE id = $1;

-- name: CountStockEntries :one
SELECT count(*)
FROM inv_stock_entry
WHERE (sqlc.arg(scope_bypass)::boolean OR company_id = ANY(sqlc.arg(company_ids)::uuid[]));

-- name: ListStockEntries :many
SELECT id, seq, quantity, posting_date, voucher_type, voucher_id, voucher_no,
       is_cancelled, cancelled_at, remarks, inserted_at,
       company_id, warehouse_id, material_id
FROM inv_stock_entry
WHERE (sqlc.arg(scope_bypass)::boolean OR company_id = ANY(sqlc.arg(company_ids)::uuid[]))
ORDER BY seq ASC
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);
