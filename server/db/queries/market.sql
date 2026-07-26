-- name: GetMarketInstrument :one
SELECT id, code, name, source_type, default_price_kind, active, fetch_enabled,
       external_last_code, external_product_group, note, currency_id, unit_id,
       inserted_at, updated_at
FROM bas_market_instrument WHERE id = $1;

-- name: LockMarketInstrument :one
SELECT id, code, name, source_type, default_price_kind, active, fetch_enabled,
       external_last_code, external_product_group, note, currency_id, unit_id,
       inserted_at, updated_at
FROM bas_market_instrument WHERE id = $1 FOR UPDATE;

-- name: CreateMarketInstrument :one
INSERT INTO bas_market_instrument (
  code, name, source_type, default_price_kind, active, fetch_enabled,
  external_last_code, external_product_group, note, currency_id, unit_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
RETURNING id, code, name, source_type, default_price_kind, active, fetch_enabled,
          external_last_code, external_product_group, note, currency_id, unit_id,
          inserted_at, updated_at;

-- name: UpdateMarketInstrument :one
UPDATE bas_market_instrument
SET name=$2, default_price_kind=$3, active=$4, fetch_enabled=$5,
    external_last_code=$6, external_product_group=$7, note=$8,
    updated_at=timezone('utc',now())
WHERE id=$1
RETURNING id, code, name, source_type, default_price_kind, active, fetch_enabled,
          external_last_code, external_product_group, note, currency_id, unit_id,
          inserted_at, updated_at;

-- name: DeleteMarketInstrument :execrows
DELETE FROM bas_market_instrument WHERE id=$1;

-- name: GetMarketPricePoint :one
SELECT id, observed_at, price, price_kind, source, is_voided, note,
       instrument_id, currency_id, unit_id, inserted_at, updated_at
FROM bas_market_price_point WHERE id=$1;

-- name: LockMarketPricePoint :one
SELECT id, observed_at, price, price_kind, source, is_voided, note,
       instrument_id, currency_id, unit_id, inserted_at, updated_at
FROM bas_market_price_point WHERE id=$1 FOR UPDATE;

-- name: CreateMarketPricePoint :one
INSERT INTO bas_market_price_point (
  observed_at, price, price_kind, source, note, instrument_id, currency_id, unit_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
RETURNING id, observed_at, price, price_kind, source, is_voided, note,
          instrument_id, currency_id, unit_id, inserted_at, updated_at;

-- name: VoidMarketPricePoint :one
UPDATE bas_market_price_point
SET is_voided=true, updated_at=timezone('utc',now())
WHERE id=$1 AND is_voided=false
RETURNING id, observed_at, price, price_kind, source, is_voided, note,
          instrument_id, currency_id, unit_id, inserted_at, updated_at;
