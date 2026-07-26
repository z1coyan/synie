-- name: CompanyHasWarehouses :one
SELECT EXISTS (SELECT 1 FROM inv_warehouse WHERE company_id = $1);

-- name: CreateSeedWarehouse :one
INSERT INTO inv_warehouse (name, is_leaf, company_id, parent_id)
VALUES ($1, $2, $3, $4)
RETURNING id, name, is_leaf, active, is_outsourced, allow_negative,
          company_id, parent_id, account_id, party_type, party_id, inserted_at, updated_at;
