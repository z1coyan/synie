-- name: GetMaterialUnit :one
SELECT id, factor, inserted_at, updated_at, material_id, unit_id
FROM inv_material_unit
WHERE id = $1;

-- name: LockMaterialUnit :one
SELECT id, factor, inserted_at, updated_at, material_id, unit_id
FROM inv_material_unit
WHERE id = $1
FOR UPDATE;

-- name: CreateMaterialUnit :one
INSERT INTO inv_material_unit (material_id, unit_id, factor)
VALUES ($1, $2, $3)
RETURNING id, factor, inserted_at, updated_at, material_id, unit_id;

-- name: UpdateMaterialUnit :one
UPDATE inv_material_unit
SET unit_id = $2,
    factor = $3,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, factor, inserted_at, updated_at, material_id, unit_id;

-- name: MaterialDefaultUnitID :one
SELECT default_unit_id FROM inv_material WHERE id = $1;

-- name: DeleteMaterialUnit :exec
DELETE FROM inv_material_unit WHERE id = $1;
