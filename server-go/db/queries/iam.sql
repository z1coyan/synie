-- name: GetIAMUser :one
SELECT id, username::text AS username, name, preferred_language, inserted_at, updated_at
FROM sys_user WHERE id = $1;

-- name: LockIAMUser :one
SELECT id, username::text AS username, name, preferred_language, inserted_at, updated_at
FROM sys_user WHERE id = $1 FOR UPDATE;

-- name: CreateIAMUser :one
INSERT INTO sys_user (username, name, hashed_password)
VALUES ($1, $2, $3)
RETURNING id, username::text AS username, name, preferred_language, inserted_at, updated_at;

-- name: UpdateIAMUser :one
UPDATE sys_user SET name = $2, updated_at = timezone('utc', now())
WHERE id = $1
RETURNING id, username::text AS username, name, preferred_language, inserted_at, updated_at;

-- name: UpdateIAMUserPassword :exec
UPDATE sys_user SET hashed_password = $2, updated_at = timezone('utc', now()) WHERE id = $1;

-- name: DeleteIAMUser :execrows
DELETE FROM sys_user WHERE id = $1;

-- name: UserAccessRoles :many
SELECT ur.role_id, role.name
FROM sys_user_role AS ur
JOIN sys_role AS role ON role.id = ur.role_id
WHERE ur.user_id = $1
ORDER BY role.name, ur.role_id;

-- name: UserAccessCompanies :many
SELECT uc.company_id, company.name
FROM sys_user_company AS uc
JOIN bas_company AS company ON company.id = uc.company_id
WHERE uc.user_id = $1
ORDER BY company.name, uc.company_id;

-- name: DeleteUserRoles :exec
DELETE FROM sys_user_role WHERE user_id = $1;

-- name: InsertUserRoles :exec
INSERT INTO sys_user_role (user_id, role_id)
SELECT $1, unnest(sqlc.arg(role_ids)::uuid[]);

-- name: DeleteUserCompanies :exec
DELETE FROM sys_user_company WHERE user_id = $1;

-- name: InsertUserCompanies :exec
INSERT INTO sys_user_company (user_id, company_id)
SELECT $1, unnest(sqlc.arg(company_ids)::uuid[]);

-- name: GetIAMRole :one
SELECT id, code, name, enabled, builtin, inserted_at, updated_at
FROM sys_role WHERE id = $1;

-- name: LockIAMRole :one
SELECT id, code, name, enabled, builtin, inserted_at, updated_at
FROM sys_role WHERE id = $1 FOR UPDATE;

-- name: CreateIAMRole :one
INSERT INTO sys_role (code, name, enabled)
VALUES ($1, $2, $3)
RETURNING id, code, name, enabled, builtin, inserted_at, updated_at;

-- name: UpdateIAMRole :one
UPDATE sys_role SET name = $2, enabled = $3, updated_at = timezone('utc', now())
WHERE id = $1
RETURNING id, code, name, enabled, builtin, inserted_at, updated_at;

-- name: DeleteIAMRole :execrows
DELETE FROM sys_role WHERE id = $1;

-- name: GetRolePermissions :many
SELECT id, permission FROM sys_role_permission WHERE role_id = $1 ORDER BY permission, id;

-- name: DeleteRolePermissions :exec
DELETE FROM sys_role_permission
WHERE role_id = $1 AND permission = ANY(sqlc.arg(permissions)::text[]);

-- name: InsertRolePermissions :exec
INSERT INTO sys_role_permission (role_id, permission)
SELECT $1, unnest(sqlc.arg(permissions)::text[])
ON CONFLICT (role_id, permission) DO NOTHING;
