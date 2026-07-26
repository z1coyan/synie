-- name: GetTradingQuotationCompany :one
SELECT id, base_currency_id
FROM bas_company
WHERE id = $1;

-- name: TradingQuotationPartyExists :one
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

-- name: GetTradingQuotationMaterialSnapshot :one
SELECT m.id,
       m.code,
       m.name,
       m.spec,
       m.customer_part_no,
       m.is_customer_material,
       m.customer_id,
       u.id AS unit_id,
       u.name AS unit_name,
       (
         m.default_unit_id = u.id OR EXISTS(
           SELECT 1
           FROM inv_material_unit mu
           WHERE mu.material_id = m.id AND mu.unit_id = u.id
         )
       )::boolean AS unit_allowed
FROM inv_material m
JOIN bas_unit u ON u.id = sqlc.arg(unit_id)::uuid
WHERE m.id = sqlc.arg(material_id)::uuid;

-- name: TradingQuotationMaterialExists :one
SELECT EXISTS(
  SELECT 1 FROM inv_material WHERE id = $1
)::boolean;
