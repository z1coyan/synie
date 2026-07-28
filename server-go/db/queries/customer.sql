-- name: GetCustomer :one
SELECT * FROM sal_customers WHERE id = $1;

-- name: LockCustomer :one
SELECT * FROM sal_customers WHERE id = $1 FOR UPDATE;

-- name: CreateCustomer :one
INSERT INTO sal_customers (code, name, short_name)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateCustomer :one
UPDATE sal_customers
SET code = $2,
    name = $3,
    short_name = $4,
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = $1
RETURNING *;

-- name: DeleteCustomer :execrows
DELETE FROM sal_customers WHERE id = $1;

-- name: CustomerHasMaterials :one
SELECT EXISTS(
  SELECT 1 FROM inv_material WHERE customer_id = $1
);
