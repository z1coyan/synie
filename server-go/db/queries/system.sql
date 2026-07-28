-- name: GetSetupStatus :one
SELECT
  EXISTS (SELECT 1 FROM sys_setting WHERE setup_completed_at IS NOT NULL) AS initialized,
  EXISTS (SELECT 1 FROM sys_user) AS has_users;

-- name: CountUnreadTodos :one
SELECT count(*)::bigint
FROM sys_todo AS todo
LEFT JOIN sys_todo_state AS state
  ON state.todo_id = todo.id
 AND state.user_id = sqlc.arg(user_id)
WHERE todo.status = 'active'
  AND (
    sqlc.arg(bypass_company_scope)::boolean
    OR todo.company_id = ANY(sqlc.arg(company_ids)::uuid[])
  )
  AND state.read_at IS NULL
  AND NOT (
    state.dismissed_at IS NOT NULL
    AND state.reset_basis_at IS NOT NULL
    AND state.reset_basis_at = todo.source_changed_at
  );
