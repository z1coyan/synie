-- Banking is currently consumed through its deep domain service. These named
-- queries document and type-check the service's lock/order and projection
-- contract for the next dbgen adoption pass.

-- name: FinanceBankingLockAccount :one
SELECT id, alias, bank_name, branch_name, holder_name, account_no, active, note,
       inserted_at, updated_at, company_id, currency_id, account_id
FROM acc_bank_account
WHERE id=$1
FOR UPDATE;

-- name: FinanceBankingLockTransaction :one
SELECT id, occurred_at, income, expense, balance, counterparty_name,
       counterparty_account, summary, note, reconciled_amount,
       unreconciled_amount, reconcile_status, inserted_at, updated_at,
       company_id, bank_account_id
FROM acc_bank_transaction
WHERE id=$1
FOR UPDATE;

-- name: FinanceBankingLockImport :one
SELECT id, status, error, imported_at, inserted_at, updated_at, company_id,
       bank_account_id, template_id, file_id, created_by_id, imported_by_id
FROM acc_bank_import
WHERE id=$1
FOR UPDATE;

-- name: FinanceBankingLockImportItem :one
SELECT id, row_no, occurred_at, income, expense, balance, counterparty_name,
       counterparty_account, summary, note, error, inserted_at, updated_at,
       import_id, company_id, transaction_id
FROM acc_bank_import_item
WHERE id=$1
FOR UPDATE;

-- name: FinanceBankingListLockedImportItems :many
SELECT id, row_no, occurred_at, income, expense, balance, counterparty_name,
       counterparty_account, summary, note, error, inserted_at, updated_at,
       import_id, company_id, transaction_id
FROM acc_bank_import_item
WHERE import_id=$1
ORDER BY row_no, id
FOR UPDATE;

-- name: FinanceBankingLockJournal :one
SELECT id, status, company_id
FROM acc_gl_journal
WHERE id=$1
FOR UPDATE;

-- name: FinanceBankingLockReconciliation :one
SELECT id, amount, inserted_at, updated_at, company_id, bank_transaction_id,
       journal_id
FROM acc_bank_reconciliation
WHERE id=$1
FOR UPDATE;

-- name: FinanceBankingReconciledTotal :one
SELECT COALESCE(sum(amount), 0)::numeric
FROM acc_bank_reconciliation
WHERE bank_transaction_id=$1;

-- name: FinanceBankingJournalDebitTotal :one
SELECT COALESCE(sum(debit), 0)::numeric
FROM acc_gl_journal_line
WHERE journal_id=$1 AND account_id=$2;

-- name: FinanceBankingJournalCreditTotal :one
SELECT COALESCE(sum(credit), 0)::numeric
FROM acc_gl_journal_line
WHERE journal_id=$1 AND account_id=$2;

-- name: FinanceBankingJournalDebitUsed :one
SELECT COALESCE(sum(r.amount), 0)::numeric
FROM acc_bank_reconciliation r
JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
JOIN acc_bank_account b ON b.id=t.bank_account_id
WHERE r.journal_id=$1 AND b.account_id=$2 AND t.income IS NOT NULL;

-- name: FinanceBankingJournalCreditUsed :one
SELECT COALESCE(sum(r.amount), 0)::numeric
FROM acc_bank_reconciliation r
JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
JOIN acc_bank_account b ON b.id=t.bank_account_id
WHERE r.journal_id=$1 AND b.account_id=$2 AND t.expense IS NOT NULL;

-- name: FinanceBankingRefreshTransactionProjection :execrows
UPDATE acc_bank_transaction
SET reconciled_amount=$2,
    unreconciled_amount=$3,
    reconcile_status=$4,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1;

-- name: FinanceBankingCreateReconciliation :one
INSERT INTO acc_bank_reconciliation (
  id, amount, company_id, bank_transaction_id, journal_id
)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, amount, inserted_at, updated_at, company_id,
          bank_transaction_id, journal_id;

-- name: FinanceBankingDeleteReconciliation :execrows
DELETE FROM acc_bank_reconciliation WHERE id=$1;

-- name: FinanceBankingLinkImportItem :execrows
UPDATE acc_bank_import_item
SET transaction_id=$2, updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1;

-- name: FinanceBankingMarkImportImported :execrows
UPDATE acc_bank_import
SET status='imported', imported_at=$2, imported_by_id=$3,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1;

-- name: FinanceBankingDuplicateImportSHA :one
SELECT EXISTS(
  SELECT 1
  FROM acc_bank_import i
  JOIN sys_file f ON f.id=i.file_id
  WHERE i.bank_account_id=$1 AND i.status<>'failed' AND f.sha256=$2
)::boolean;
