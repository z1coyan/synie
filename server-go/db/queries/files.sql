-- name: GetStoredFile :one
SELECT id, storage, key, filename, content_type, size, sha256, inserted_at, uploaded_by_id
FROM sys_file
WHERE id = $1;

-- name: LockStoredFile :one
SELECT id, storage, key, filename, content_type, size, sha256, inserted_at, uploaded_by_id
FROM sys_file
WHERE id = $1
FOR UPDATE;

-- name: CreateStoredFile :one
INSERT INTO sys_file
  (storage, key, filename, content_type, size, sha256, uploaded_by_id)
VALUES
  ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, storage, key, filename, content_type, size, sha256, inserted_at, uploaded_by_id;

-- name: DeleteStoredFile :execrows
DELETE FROM sys_file WHERE id = $1;

-- name: GetAttachment :one
SELECT id, file_id, owner_type, owner_id, category, company_id, inserted_at
FROM sys_attachment
WHERE id = $1;

-- name: CreateAttachment :one
INSERT INTO sys_attachment
  (file_id, owner_type, owner_id, category, company_id)
VALUES
  ($1, $2, $3, $4, $5)
RETURNING id, file_id, owner_type, owner_id, category, company_id, inserted_at;

-- name: DeleteAttachment :execrows
DELETE FROM sys_attachment WHERE id = $1;

-- name: GetStorageEndpoint :one
SELECT id, name, label, kind, root, endpoint, region, bucket, prefix,
       access_key_id, secret_access_key, builtin, is_default, inserted_at, updated_at
FROM sys_storage
WHERE id = $1;

-- name: LockStorageEndpoint :one
SELECT id, name, label, kind, root, endpoint, region, bucket, prefix,
       access_key_id, secret_access_key, builtin, is_default, inserted_at, updated_at
FROM sys_storage
WHERE id = $1
FOR UPDATE;

-- name: CreateStorageEndpoint :one
INSERT INTO sys_storage
  (name, label, kind, root, endpoint, region, bucket, prefix, access_key_id, secret_access_key)
VALUES
  ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, name, label, kind, root, endpoint, region, bucket, prefix,
          access_key_id, secret_access_key, builtin, is_default, inserted_at, updated_at;

-- name: UpdateStorageEndpoint :one
UPDATE sys_storage
SET label = $2,
    root = $3,
    endpoint = $4,
    region = $5,
    bucket = $6,
    prefix = $7,
    access_key_id = $8,
    secret_access_key = $9,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING id, name, label, kind, root, endpoint, region, bucket, prefix,
          access_key_id, secret_access_key, builtin, is_default, inserted_at, updated_at;

-- name: DeleteStorageEndpoint :execrows
DELETE FROM sys_storage WHERE id = $1;
