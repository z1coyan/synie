-- name: GetMaterialCategory :one
SELECT id, code, name, is_leaf, active, inserted_at, updated_at, parent_id
FROM inv_material_category
WHERE id = $1;

-- name: LockMaterialCategory :one
SELECT id, code, name, is_leaf, active, inserted_at, updated_at, parent_id
FROM inv_material_category
WHERE id = $1
FOR UPDATE;

-- name: CreateMaterialCategory :one
INSERT INTO inv_material_category (code, name, is_leaf, active, parent_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, code, name, is_leaf, active, inserted_at, updated_at, parent_id;

-- name: UpdateMaterialCategory :one
UPDATE inv_material_category
SET code = $2,
    name = $3,
    is_leaf = $4,
    active = $5,
    parent_id = $6,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, code, name, is_leaf, active, inserted_at, updated_at, parent_id;

-- name: MaterialCategoryHasChildren :one
SELECT EXISTS(SELECT 1 FROM inv_material_category WHERE parent_id = $1);

-- name: MaterialCategoryHasMaterials :one
SELECT EXISTS(SELECT 1 FROM inv_material WHERE category_id = $1);

-- name: DeleteMaterialCategory :exec
DELETE FROM inv_material_category WHERE id = $1;
