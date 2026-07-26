-- PR-2.18 system operations query catalogue.
-- Dynamic list filters/sorts are assembled from ResourceMeta by filterbuild;
-- these named statements document and validate the fixed transactional seams.

-- name: GetSystemAuditLog :one
SELECT id, inserted_at, resource, record_id, record_label, action_type,
       action_name, actor_id, actor_name, company_id, changes
FROM sys_audit_log
WHERE id = sqlc.arg(id);

-- name: OpenSystemTodo :one
INSERT INTO sys_todo (
  type, source_type, source_id, source_no, party_type, party_id, amount,
  status, source_changed_at, company_id, created_by_id
) VALUES (
  sqlc.arg(type), sqlc.arg(source_type), sqlc.arg(source_id),
  sqlc.arg(source_no), sqlc.arg(party_type), sqlc.arg(party_id),
  sqlc.arg(amount), 'active', sqlc.arg(source_changed_at),
  sqlc.arg(company_id), sqlc.narg(created_by_id)
)
RETURNING id, type, source_type, source_id, source_no, party_type, party_id,
          amount, status, closed_reason, source_changed_at, closed_at,
          inserted_at, updated_at, company_id, created_by_id;

-- name: CloseSystemTodos :many
UPDATE sys_todo
SET status = 'closed',
    closed_reason = sqlc.arg(closed_reason),
    closed_at = sqlc.arg(closed_at),
    updated_at = sqlc.arg(closed_at)
WHERE source_type = sqlc.arg(source_type)
  AND source_id = sqlc.arg(source_id)
  AND status = 'active'
RETURNING id, type, source_type, source_id, source_no, party_type, party_id,
          amount, status, closed_reason, source_changed_at, closed_at,
          inserted_at, updated_at, company_id, created_by_id;

-- name: TouchSystemTodo :exec
UPDATE sys_todo
SET updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);

-- name: UpsertSystemTodoState :one
INSERT INTO sys_todo_state (
  todo_id, user_id, read_at, dismissed_at, reset_basis_at
) VALUES (
  sqlc.arg(todo_id), sqlc.arg(user_id), sqlc.narg(read_at),
  sqlc.narg(dismissed_at), sqlc.narg(reset_basis_at)
)
ON CONFLICT (todo_id, user_id) DO UPDATE
SET read_at = COALESCE(EXCLUDED.read_at, sys_todo_state.read_at),
    dismissed_at = COALESCE(EXCLUDED.dismissed_at, sys_todo_state.dismissed_at),
    reset_basis_at = COALESCE(EXCLUDED.reset_basis_at, sys_todo_state.reset_basis_at),
    updated_at = (now() AT TIME ZONE 'utc')
RETURNING id, read_at, dismissed_at, reset_basis_at, inserted_at, updated_at,
          todo_id, user_id;
