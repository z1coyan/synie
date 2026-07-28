-- PR-2.15 fulfillment aggregates use fixed, generated table access for their
-- lock/read seams. Dynamic list filtering remains in the domain query layer,
-- where identifiers come only from compile-time side specifications.

-- name: GetSalDelivery :one
SELECT * FROM sal_delivery WHERE id = $1;

-- name: LockSalDelivery :one
SELECT * FROM sal_delivery WHERE id = $1 FOR UPDATE;

-- name: GetSalDeliveryItem :one
SELECT * FROM sal_delivery_item WHERE id = $1;

-- name: LockSalDeliveryItem :one
SELECT * FROM sal_delivery_item WHERE id = $1 FOR UPDATE;

-- name: ListSalDeliveryItemsForHead :many
SELECT * FROM sal_delivery_item
WHERE delivery_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetPurReceipt :one
SELECT * FROM pur_receipt WHERE id = $1;

-- name: LockPurReceipt :one
SELECT * FROM pur_receipt WHERE id = $1 FOR UPDATE;

-- name: GetPurReceiptItem :one
SELECT * FROM pur_receipt_item WHERE id = $1;

-- name: LockPurReceiptItem :one
SELECT * FROM pur_receipt_item WHERE id = $1 FOR UPDATE;

-- name: ListPurReceiptItemsForHead :many
SELECT * FROM pur_receipt_item
WHERE receipt_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetPurOutsourcedIssue :one
SELECT * FROM pur_outsourced_issue WHERE id = $1;

-- name: LockPurOutsourcedIssue :one
SELECT * FROM pur_outsourced_issue WHERE id = $1 FOR UPDATE;

-- name: GetPurOutsourcedIssueItem :one
SELECT * FROM pur_outsourced_issue_item WHERE id = $1;

-- name: LockPurOutsourcedIssueItem :one
SELECT * FROM pur_outsourced_issue_item WHERE id = $1 FOR UPDATE;

-- name: ListPurOutsourcedIssueItemsForHead :many
SELECT * FROM pur_outsourced_issue_item
WHERE issue_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetPurOutsourcedReceipt :one
SELECT * FROM pur_outsourced_receipt WHERE id = $1;

-- name: LockPurOutsourcedReceipt :one
SELECT * FROM pur_outsourced_receipt WHERE id = $1 FOR UPDATE;

-- name: GetPurOutsourcedReceiptItem :one
SELECT * FROM pur_outsourced_receipt_item WHERE id = $1;

-- name: LockPurOutsourcedReceiptItem :one
SELECT * FROM pur_outsourced_receipt_item WHERE id = $1 FOR UPDATE;

-- name: ListPurOutsourcedReceiptItemsForHead :many
SELECT * FROM pur_outsourced_receipt_item
WHERE receipt_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetPurOutsourcedReceiptItemMaterial :one
SELECT * FROM pur_outsourced_receipt_item_material WHERE id = $1;

-- name: LockPurOutsourcedReceiptItemMaterial :one
SELECT * FROM pur_outsourced_receipt_item_material WHERE id = $1 FOR UPDATE;

-- name: ListPurOutsourcedReceiptItemMaterials :many
SELECT * FROM pur_outsourced_receipt_item_material
WHERE receipt_item_id = $1
ORDER BY idx ASC, id ASC;

-- name: GetPurOutsourcedReceiptItemByproduct :one
SELECT * FROM pur_outsourced_receipt_item_byproduct WHERE id = $1;

-- name: LockPurOutsourcedReceiptItemByproduct :one
SELECT * FROM pur_outsourced_receipt_item_byproduct WHERE id = $1 FOR UPDATE;

-- name: ListPurOutsourcedReceiptItemByproducts :many
SELECT * FROM pur_outsourced_receipt_item_byproduct
WHERE receipt_item_id = $1
ORDER BY idx ASC, id ASC;
