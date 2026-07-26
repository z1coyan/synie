-- name: CredentialsByUsername :one
SELECT id, username::text AS username, name, hashed_password
FROM sys_user
WHERE username = $1;

-- name: UserActorBase :one
SELECT id, username::text AS username, name, super_admin, all_companies
FROM sys_user
WHERE id = $1;

-- name: UserPermissions :many
SELECT DISTINCT rp.permission
FROM sys_user_role ur
JOIN sys_role r ON r.id = ur.role_id AND r.enabled = true
JOIN sys_role_permission rp ON rp.role_id = r.id
WHERE ur.user_id = $1
ORDER BY rp.permission;

-- name: UserCompanyIDs :many
SELECT company_id
FROM sys_user_company
WHERE user_id = $1
ORDER BY company_id;
