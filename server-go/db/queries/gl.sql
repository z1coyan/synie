-- name: GetGLAccounts :many
SELECT id, name, company_id, is_group, active, role
FROM bas_account
WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: InsertGLEntry :one
INSERT INTO acc_gl_entry (
  company_id, account_id, currency_id, posting_date,
  debit, credit, party_type, party_id,
  voucher_type, voucher_id, voucher_no, remarks, is_reversal
)
VALUES (
  $1, $2, $3, $4,
  $5, $6, $7, $8,
  $9, $10, $11, $12, $13
)
RETURNING id, seq, posting_date, debit, credit, party_type, party_id,
          voucher_type, voucher_id, voucher_no, is_cancelled, remarks,
          inserted_at, company_id, account_id, currency_id, is_reversed,
          is_reversal;

-- name: CancelGLEntriesForVoucher :execrows
UPDATE acc_gl_entry
SET is_cancelled = true
WHERE voucher_type = $1
  AND voucher_id = $2
  AND is_cancelled = false;

-- name: LockReversibleGLEntriesForVoucher :many
SELECT id, seq, posting_date, debit, credit, party_type, party_id,
       voucher_type, voucher_id, voucher_no, is_cancelled, remarks,
       inserted_at, company_id, account_id, currency_id, is_reversed,
       is_reversal
FROM acc_gl_entry
WHERE voucher_type = $1
  AND voucher_id = $2
  AND is_cancelled = false
  AND is_reversed = false
  AND is_reversal = false
ORDER BY seq ASC
FOR UPDATE;

-- name: MarkGLEntriesReversed :execrows
UPDATE acc_gl_entry
SET is_reversed = true
WHERE id = ANY(sqlc.arg(ids)::uuid[])
  AND is_reversed = false;
