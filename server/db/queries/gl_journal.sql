-- name: GetGLJournal :one
SELECT j.id, j.voucher_no, j.date, j.posting_date, j.remarks, j.status,
       j.submitted_at, j.inserted_at, j.updated_at, j.company_id,
       j.created_by_id, j.submitted_by_id,
       COALESCE((SELECT sum(l.debit) FROM acc_gl_journal_line l WHERE l.journal_id=j.id), 0)::numeric AS debit_total,
       COALESCE((SELECT sum(l.credit) FROM acc_gl_journal_line l WHERE l.journal_id=j.id), 0)::numeric AS credit_total,
       c.name AS company_name,
       creator.name AS created_by_name,
       submitter.name AS submitted_by_name
FROM acc_gl_journal j
JOIN bas_company c ON c.id=j.company_id
LEFT JOIN sys_user creator ON creator.id=j.created_by_id
LEFT JOIN sys_user submitter ON submitter.id=j.submitted_by_id
WHERE j.id=$1;

-- name: LockGLJournal :one
SELECT id, voucher_no, date, posting_date, remarks, status, submitted_at,
       inserted_at, updated_at, company_id, created_by_id, submitted_by_id
FROM acc_gl_journal
WHERE id=$1
FOR UPDATE;

-- name: CreateGLJournal :one
INSERT INTO acc_gl_journal (
  voucher_no, date, posting_date, remarks, company_id, created_by_id
)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, voucher_no, date, posting_date, remarks, status, submitted_at,
          inserted_at, updated_at, company_id, created_by_id, submitted_by_id;

-- name: UpdateGLJournal :one
UPDATE acc_gl_journal
SET voucher_no=$2, date=$3, posting_date=$4, remarks=$5,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id, voucher_no, date, posting_date, remarks, status, submitted_at,
          inserted_at, updated_at, company_id, created_by_id, submitted_by_id;

-- name: AuditGLJournal :one
UPDATE acc_gl_journal
SET status='audited', posting_date=$2, submitted_at=$3, submitted_by_id=$4,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id, voucher_no, date, posting_date, remarks, status, submitted_at,
          inserted_at, updated_at, company_id, created_by_id, submitted_by_id;

-- name: CancelGLJournal :one
UPDATE acc_gl_journal
SET status='cancelled', updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id, voucher_no, date, posting_date, remarks, status, submitted_at,
          inserted_at, updated_at, company_id, created_by_id, submitted_by_id;

-- name: DeleteGLJournal :execrows
DELETE FROM acc_gl_journal WHERE id=$1;

-- name: GLJournalHasBankReconciliation :one
SELECT EXISTS(
  SELECT 1 FROM acc_bank_reconciliation WHERE journal_id=$1
)::boolean;

-- name: GetGLJournalLine :one
SELECT l.id, l.idx, l.debit, l.credit, l.party_type, l.party_id, l.remarks,
       l.inserted_at, l.updated_at, l.journal_id, l.company_id, l.account_id,
       l.currency_id, j.voucher_no, c.name AS company_name,
       a.code AS account_code, a.name AS account_name,
       cur.iso_code AS currency_code, cur.name AS currency_name
FROM acc_gl_journal_line l
JOIN acc_gl_journal j ON j.id=l.journal_id
JOIN bas_company c ON c.id=l.company_id
JOIN bas_account a ON a.id=l.account_id
LEFT JOIN bas_currency cur ON cur.id=l.currency_id
WHERE l.id=$1;

-- name: ListGLJournalLinesByJournal :many
SELECT l.id, l.idx, l.debit, l.credit, l.party_type, l.party_id, l.remarks,
       l.inserted_at, l.updated_at, l.journal_id, l.company_id, l.account_id,
       l.currency_id, j.voucher_no, c.name AS company_name,
       a.code AS account_code, a.name AS account_name,
       cur.iso_code AS currency_code, cur.name AS currency_name
FROM acc_gl_journal_line l
JOIN acc_gl_journal j ON j.id=l.journal_id
JOIN bas_company c ON c.id=l.company_id
JOIN bas_account a ON a.id=l.account_id
LEFT JOIN bas_currency cur ON cur.id=l.currency_id
WHERE l.journal_id=$1
ORDER BY l.idx ASC, l.id ASC;

-- name: LockGLJournalLine :one
SELECT id, idx, debit, credit, party_type, party_id, remarks, inserted_at,
       updated_at, journal_id, company_id, account_id, currency_id
FROM acc_gl_journal_line
WHERE id=$1
FOR UPDATE;

-- name: CreateGLJournalLine :one
INSERT INTO acc_gl_journal_line (
  idx, debit, credit, party_type, party_id, remarks, journal_id, company_id,
  account_id, currency_id
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
RETURNING id, idx, debit, credit, party_type, party_id, remarks, inserted_at,
          updated_at, journal_id, company_id, account_id, currency_id;

-- name: UpdateGLJournalLine :one
UPDATE acc_gl_journal_line
SET idx=$2, debit=$3, credit=$4, party_type=$5, party_id=$6, remarks=$7,
    account_id=$8, currency_id=$9, updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id, idx, debit, credit, party_type, party_id, remarks, inserted_at,
          updated_at, journal_id, company_id, account_id, currency_id;

-- name: DeleteGLJournalLine :execrows
DELETE FROM acc_gl_journal_line WHERE id=$1;

-- name: GetGLJournalLineAccount :one
SELECT id, company_id, currency_id, is_group, active
FROM bas_account
WHERE id=$1;

-- name: GLJournalPartyExists :one
SELECT CASE sqlc.arg(party_type)::text
  WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier s WHERE s.id=sqlc.arg(party_id)::uuid)
  WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers c WHERE c.id=sqlc.arg(party_id)::uuid)
  WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company c WHERE c.id=sqlc.arg(party_id)::uuid)
  WHEN 'employee' THEN EXISTS(SELECT 1 FROM hr_employees e WHERE e.id=sqlc.arg(party_id)::uuid)
  ELSE false
END::boolean;
