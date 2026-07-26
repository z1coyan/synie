-- name: GetNumberingRule :one
SELECT id, resource, name, to_json(segments) AS segments, per_company, enabled,
       inserted_at, updated_at
FROM sys_numbering_rule
WHERE id = $1;

-- name: GetEnabledNumberingRule :one
SELECT id, resource, name, to_json(segments) AS segments, per_company, enabled,
       inserted_at, updated_at
FROM sys_numbering_rule
WHERE resource = $1 AND enabled = true;

-- name: LockNumberingRule :one
SELECT id, resource, name, to_json(segments) AS segments, per_company, enabled,
       inserted_at, updated_at
FROM sys_numbering_rule
WHERE id = $1
FOR UPDATE;

-- name: CreateNumberingRule :one
INSERT INTO sys_numbering_rule (resource, name, segments, per_company, enabled)
VALUES (
  $1,
  $2,
  ARRAY(SELECT value FROM jsonb_array_elements(sqlc.arg(segments)::jsonb)),
  $3,
  $4
)
RETURNING id, resource, name, to_json(segments) AS segments, per_company, enabled,
          inserted_at, updated_at;

-- name: UpdateNumberingRule :one
UPDATE sys_numbering_rule
SET name = $2,
    segments = ARRAY(SELECT value FROM jsonb_array_elements(sqlc.arg(segments)::jsonb)),
    per_company = $3,
    enabled = $4,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, resource, name, to_json(segments) AS segments, per_company, enabled,
          inserted_at, updated_at;

-- name: DeleteNumberingRule :execrows
DELETE FROM sys_numbering_rule WHERE id = $1;

-- name: GetNumberingCounter :one
SELECT id, rule_id, scope_key, value, inserted_at, updated_at
FROM sys_numbering_counter
WHERE id = $1;

-- name: LockNumberingCounter :one
SELECT id, rule_id, scope_key, value, inserted_at, updated_at
FROM sys_numbering_counter
WHERE id = $1
FOR UPDATE;

-- name: UpdateNumberingCounter :one
UPDATE sys_numbering_counter
SET value = $2, updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, rule_id, scope_key, value, inserted_at, updated_at;

-- name: IncrementNumberingCounter :one
INSERT INTO sys_numbering_counter (rule_id, scope_key, value)
VALUES ($1, $2, 1)
ON CONFLICT (rule_id, scope_key)
DO UPDATE
SET value = sys_numbering_counter.value + 1,
    updated_at = (now() AT TIME ZONE 'utc')
RETURNING value;
