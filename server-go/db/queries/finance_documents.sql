-- Canonical finance-document SQL surface. The documents domain currently uses
-- these shapes through caller-owned pgx transactions; keeping the statements
-- here lets the root integration generate typed adapters without weakening the
-- aggregate transaction boundary.

-- name: FinanceDocumentsLockVatInvoice :one
SELECT *
FROM acc_vat_invoice
WHERE id = $1
FOR UPDATE;

-- name: FinanceDocumentsLockExpenseReport :one
SELECT *
FROM acc_expense_report
WHERE id = $1
FOR UPDATE;

-- name: FinanceDocumentsLockExpenseReportItems :many
SELECT *
FROM acc_expense_report_item
WHERE report_id = $1
ORDER BY idx, id
FOR UPDATE;

-- name: FinanceDocumentsLockBill :one
SELECT *
FROM acc_bill
WHERE id = $1
FOR UPDATE;

-- name: FinanceDocumentsLockBillTransaction :one
SELECT *
FROM acc_bill_transaction
WHERE id = $1
FOR UPDATE;

-- name: FinanceDocumentsListAuditedBillTransactionsForReplay :many
SELECT *
FROM acc_bill_transaction
WHERE bill_id = $1
  AND status = 'audited'
ORDER BY occurred_on, audited_at, id;

-- name: FinanceDocumentsDeleteBillHoldingsForReplay :exec
DELETE FROM acc_bill_holding
WHERE bill_id = $1;

-- name: FinanceDocumentsInsertBillHoldingForReplay :one
INSERT INTO acc_bill_holding (
  bill_no,
  sub_start,
  sub_end,
  amount,
  due_date,
  acquired_on,
  company_id,
  bank_account_id,
  bill_id,
  source_transaction_id
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
)
RETURNING *;

-- name: FinanceDocumentsBillVisibleToCompanies :one
SELECT EXISTS (
  SELECT 1
  FROM acc_bill_transaction
  WHERE bill_id = $1
    AND company_id = ANY($2::uuid[])
);

-- name: FinanceDocumentsInvoiceReferencedByLiveExpenseReport :one
SELECT EXISTS (
  SELECT 1
  FROM acc_expense_report_item item
  JOIN acc_expense_report report ON report.id = item.report_id
  WHERE item.invoice_id = $1
    AND report.status <> 'voided'
);

-- name: FinanceDocumentsLockInvoiceForExpense :one
SELECT *
FROM acc_vat_invoice
WHERE id = $1
FOR UPDATE;

-- name: FinanceDocumentsFindBillByNumberForRegister :one
SELECT *
FROM acc_bill
WHERE bill_no = $1
FOR UPDATE;
