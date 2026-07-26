-- name: GetUnit :one
SELECT id, unit_type, is_base, name, symbol, ratio, inserted_at, updated_at FROM bas_unit WHERE id = $1;
-- name: LockUnit :one
SELECT id, unit_type, is_base, name, symbol, ratio, inserted_at, updated_at FROM bas_unit WHERE id = $1 FOR UPDATE;
-- name: CreateUnit :one
INSERT INTO bas_unit (unit_type, is_base, name, symbol, ratio) VALUES ($1,$2,$3,$4,$5)
RETURNING id, unit_type, is_base, name, symbol, ratio, inserted_at, updated_at;
-- name: UpdateUnit :one
UPDATE bas_unit SET unit_type=$2,is_base=$3,name=$4,symbol=$5,ratio=$6,updated_at=timezone('utc',now()) WHERE id=$1
RETURNING id, unit_type, is_base, name, symbol, ratio, inserted_at, updated_at;
-- name: DeleteUnit :execrows
DELETE FROM bas_unit WHERE id=$1;
