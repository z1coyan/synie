-- name: GetGLEntry :one
SELECT id, seq, posting_date, debit, credit, party_type, party_id,
       voucher_type, voucher_id, voucher_no, is_cancelled, remarks,
       inserted_at, company_id, account_id, currency_id, is_reversed,
       is_reversal
FROM acc_gl_entry
WHERE id = $1;

-- name: ListGLPartyRoleAccounts :many
SELECT id, code, name, role
FROM bas_account
WHERE company_id = $1
  AND role = ANY(sqlc.arg(roles)::text[])
ORDER BY role ASC, code ASC, id ASC;

-- name: GLARAPBalances :many
SELECT party_type, party_id, account_id,
       sum(debit)::numeric AS debit,
       sum(credit)::numeric AS credit
FROM acc_gl_entry
WHERE company_id = $1
  AND posting_date <= $2
  AND is_cancelled = false
  AND account_id = ANY(sqlc.arg(account_ids)::uuid[])
GROUP BY party_type, party_id, account_id;

-- name: ListGLPartyLabels :many
SELECT 'customer'::text AS party_type, id, name
FROM sal_customers
WHERE id = ANY(sqlc.arg(customer_ids)::uuid[])
UNION ALL
SELECT 'supplier'::text AS party_type, id, name
FROM pur_supplier
WHERE id = ANY(sqlc.arg(supplier_ids)::uuid[])
UNION ALL
SELECT 'company'::text AS party_type, id, name
FROM bas_company
WHERE id = ANY(sqlc.arg(company_ids)::uuid[])
UNION ALL
SELECT 'employee'::text AS party_type, id, name
FROM hr_employees
WHERE id = ANY(sqlc.arg(employee_ids)::uuid[]);
