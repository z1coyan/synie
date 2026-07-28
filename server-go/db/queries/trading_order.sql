-- Fixed persistence helpers for the shared trading/order module. Side-specific
-- aggregate queries remain in the module because sqlc cannot parameterize table
-- identifiers; all identifiers there come from the compile-time side spec.

-- name: GetTradingOrderCompany :one
SELECT id, base_currency_id
FROM bas_company
WHERE id = $1;

-- name: TradingOrderPartyExists :one
SELECT CASE sqlc.arg(party_type)::text
  WHEN 'supplier' THEN EXISTS(
    SELECT 1 FROM pur_supplier WHERE id = sqlc.arg(party_id)::uuid
  )
  WHEN 'customer' THEN EXISTS(
    SELECT 1 FROM sal_customers WHERE id = sqlc.arg(party_id)::uuid
  )
  WHEN 'company' THEN EXISTS(
    SELECT 1 FROM bas_company WHERE id = sqlc.arg(party_id)::uuid
  )
  ELSE false
END::boolean;

-- name: GetTradingOrderMaterial :one
SELECT m.id,
       m.code,
       m.name,
       m.spec,
       m.customer_part_no,
       m.default_unit_id,
       m.is_customer_material,
       m.customer_id,
       u.id AS unit_id,
       u.name AS unit_name,
       mu.factor,
       (m.default_unit_id = u.id OR mu.id IS NOT NULL)::boolean AS unit_allowed
FROM inv_material m
JOIN bas_unit u ON u.id = sqlc.arg(unit_id)::uuid
LEFT JOIN inv_material_unit mu
  ON mu.material_id = m.id AND mu.unit_id = u.id
WHERE m.id = sqlc.arg(material_id)::uuid;

-- name: ListTradingOrderDemandPool :many
SELECT i.id,
       i.demand_id,
       d.demand_no,
       i.idx,
       i.need_date,
       i.company_id,
       i.material_id,
       i.unit_id,
       i.material_code,
       i.material_name,
       i.material_spec,
       i.unit_name,
       i.base_qty,
       i.ordered_qty,
       i.base_qty - i.ordered_qty AS remaining_base_qty,
       CASE
         WHEN i.unit_id = m.default_unit_id THEN i.base_qty - i.ordered_qty
         ELSE (i.base_qty - i.ordered_qty) * mu.factor
       END AS suggested_qty
FROM mfg_demand_item i
JOIN mfg_demand d ON d.id = i.demand_id
JOIN inv_material m ON m.id = i.material_id
LEFT JOIN inv_material_unit mu
  ON mu.material_id = i.material_id AND mu.unit_id = i.unit_id
WHERE i.company_id = sqlc.arg(company_id)::uuid
  AND d.status = 'confirmed'
  AND i.status <> 'completed'
  AND i.fulfillment_method = sqlc.arg(fulfillment_method)::text
  AND i.ordered_qty < i.base_qty
ORDER BY i.need_date ASC NULLS LAST, i.inserted_at ASC, i.id ASC
LIMIT sqlc.arg(row_limit);

-- name: PreviewTradingOrderBOMMaterials :many
SELECT x.material_id,
       m.code AS material_code,
       m.name AS material_name,
       x.unit_id,
       u.name AS unit_name,
       x.quantity * (1 + coalesce(x.loss_rate, 0)) * sqlc.arg(order_qty)::numeric AS quantity,
       x.note
FROM mfg_bom_component x
JOIN inv_material m ON m.id = x.material_id
JOIN bas_unit u ON u.id = x.unit_id
WHERE x.bom_id = sqlc.arg(bom_id)::uuid
ORDER BY x.inserted_at, x.id;

-- name: PreviewTradingOrderBOMByproducts :many
SELECT x.material_id,
       m.code AS material_code,
       m.name AS material_name,
       x.unit_id,
       u.name AS unit_name,
       x.quantity * sqlc.arg(order_qty)::numeric AS quantity,
       x.note
FROM mfg_bom_byproduct x
JOIN inv_material m ON m.id = x.material_id
JOIN bas_unit u ON u.id = x.unit_id
WHERE x.bom_id = sqlc.arg(bom_id)::uuid
ORDER BY x.inserted_at, x.id;
