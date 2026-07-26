-- PR-2.16 的静态 SQLC seam。动态结构化筛选仍由领域模块在 ResourceMeta
-- 白名单下构造；单行读取与受控来源读取保留为可生成、可审计的 SQL。

-- name: GetSalesReconciliation :one
SELECT *
FROM sal_reconciliation
WHERE id = $1;

-- name: GetSalesReconciliationItem :one
SELECT *
FROM sal_reconciliation_item
WHERE id = $1;

-- name: GetPurchaseReconciliation :one
SELECT *
FROM pur_reconciliation
WHERE id = $1;

-- name: GetPurchaseReconciliationItem :one
SELECT *
FROM pur_reconciliation_item
WHERE id = $1;

-- name: GetCompanyAccountDefault :one
SELECT *
FROM sal_company_account_default
WHERE id = $1;

-- name: GetCompanyAccountDefaultByCompany :one
SELECT *
FROM sal_company_account_default
WHERE company_id = $1;

-- name: GetOrderFlowItem :one
SELECT *
FROM scm_order_flow_item
WHERE id = $1::text;
