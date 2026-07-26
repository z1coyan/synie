-- name: ReplacePrintTemplateAttachment :exec
WITH removed AS (
  DELETE FROM sys_attachment
  WHERE owner_type = 'sys_print_template'
    AND owner_id = sqlc.arg(template_id)::uuid
)
INSERT INTO sys_attachment (file_id, owner_type, owner_id, category, company_id)
VALUES (
  sqlc.arg(file_id)::uuid,
  'sys_print_template',
  sqlc.arg(template_id)::uuid,
  'template',
  NULL
);

-- name: DeletePrintTemplateAttachments :exec
DELETE FROM sys_attachment
WHERE owner_type = 'sys_print_template'
  AND owner_id = sqlc.arg(template_id)::uuid;
