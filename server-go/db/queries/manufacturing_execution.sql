-- name: GetManufacturingDemand :one
SELECT *
FROM mfg_demand
WHERE id = $1;

-- name: LockManufacturingDemand :one
SELECT *
FROM mfg_demand
WHERE id = $1
FOR UPDATE;

-- name: ListManufacturingDemandItems :many
SELECT *
FROM mfg_demand_item
WHERE demand_id = $1
ORDER BY idx, id;

-- name: LockManufacturingDemandItem :one
SELECT *
FROM mfg_demand_item
WHERE id = $1
FOR UPDATE;

-- name: GetManufacturingWorkOrder :one
SELECT *
FROM mfg_work_order
WHERE id = $1;

-- name: LockManufacturingWorkOrder :one
SELECT *
FROM mfg_work_order
WHERE id = $1
FOR UPDATE;

-- name: ListManufacturingOutputItemsForUpdate :many
SELECT *
FROM mfg_output_item
WHERE output_id = $1
ORDER BY idx, id
FOR UPDATE;

-- name: LockManufacturingOutput :one
SELECT *
FROM mfg_output
WHERE id = $1
FOR UPDATE;

-- name: ManufacturingSalesOccupancy :one
SELECT
  i.id AS sales_order_item_id,
  i.base_qty AS ordered_base_qty,
  COALESCE(SUM(di.base_qty) FILTER (WHERE d.status = 'confirmed'), 0)::numeric
    AS occupied_base_qty
FROM sal_order_item AS i
LEFT JOIN mfg_demand_item AS di ON di.sales_order_item_id = i.id
LEFT JOIN mfg_demand AS d ON d.id = di.demand_id
WHERE i.id = $1
GROUP BY i.id, i.base_qty;

-- name: ManufacturingHasActivePurchaseOrder :one
SELECT EXISTS (
  SELECT 1
  FROM pur_order_item AS oi
  JOIN pur_order AS o ON o.id = oi.order_id
  JOIN mfg_demand_item AS i ON i.id = oi.demand_line_id
  WHERE i.demand_id = $1
    AND o.status IN ('audited', 'closed')
);

-- name: ManufacturingOutputOverreceiveRatio :one
SELECT COALESCE(
  (
    SELECT output_overreceive_ratio
    FROM mfg_setting
    ORDER BY inserted_at, id
    LIMIT 1
  ),
  0
)::numeric AS output_overreceive_ratio;
