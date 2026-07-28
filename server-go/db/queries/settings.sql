-- name: GetSalesSetting :one
SELECT id, sample_item_max_qty, delivery_overship_ratio, spot_item_max_qty,
       receipt_overreceive_ratio, demand_overorder_ratio, inserted_at, updated_at
FROM sal_setting ORDER BY id LIMIT 1;

-- name: LockSalesSetting :one
SELECT id, sample_item_max_qty, delivery_overship_ratio, spot_item_max_qty,
       receipt_overreceive_ratio, demand_overorder_ratio, inserted_at, updated_at
FROM sal_setting ORDER BY id LIMIT 1 FOR UPDATE;

-- name: UpdateSalesSetting :one
UPDATE sal_setting
SET sample_item_max_qty = sqlc.arg(sample_item_max_qty),
    delivery_overship_ratio = sqlc.arg(delivery_overship_ratio),
    spot_item_max_qty = sqlc.arg(spot_item_max_qty),
    receipt_overreceive_ratio = sqlc.arg(receipt_overreceive_ratio),
    demand_overorder_ratio = sqlc.arg(demand_overorder_ratio),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, sample_item_max_qty, delivery_overship_ratio, spot_item_max_qty,
          receipt_overreceive_ratio, demand_overorder_ratio, inserted_at, updated_at;

-- name: GetManufacturingSetting :one
SELECT id, output_overreceive_ratio, inserted_at, updated_at
FROM mfg_setting ORDER BY id LIMIT 1;

-- name: LockManufacturingSetting :one
SELECT id, output_overreceive_ratio, inserted_at, updated_at
FROM mfg_setting ORDER BY id LIMIT 1 FOR UPDATE;

-- name: UpdateManufacturingSetting :one
UPDATE mfg_setting
SET output_overreceive_ratio = sqlc.arg(output_overreceive_ratio),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, output_overreceive_ratio, inserted_at, updated_at;

-- name: GetAccountingSetting :one
SELECT id, ocr_access_key_id, inserted_at, updated_at
FROM acc_setting ORDER BY id LIMIT 1;

-- name: GetAccountingSettingInternal :one
SELECT id, ocr_access_key_id, ocr_access_key_secret, inserted_at, updated_at
FROM acc_setting ORDER BY id LIMIT 1;

-- name: LockAccountingSetting :one
SELECT id, ocr_access_key_id, ocr_access_key_secret, inserted_at, updated_at
FROM acc_setting ORDER BY id LIMIT 1 FOR UPDATE;

-- name: UpdateAccountingSetting :one
UPDATE acc_setting
SET ocr_access_key_id = sqlc.narg(ocr_access_key_id),
    ocr_access_key_secret = sqlc.narg(ocr_access_key_secret),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, ocr_access_key_id, ocr_access_key_secret, inserted_at, updated_at;

-- name: GetSystemSetting :one
SELECT id, market_fetch_schedule_enabled, market_fetch_last_interval_minutes,
       market_fetch_settlement_enabled, market_fetch_last_run_at,
       market_fetch_last_summary, inserted_at, updated_at
FROM sys_setting ORDER BY id LIMIT 1;

-- name: LockSystemSetting :one
SELECT id, market_fetch_schedule_enabled, market_fetch_last_interval_minutes,
       market_fetch_settlement_enabled, market_fetch_last_run_at,
       market_fetch_last_summary, inserted_at, updated_at
FROM sys_setting ORDER BY id LIMIT 1 FOR UPDATE;

-- name: UpdateSystemSetting :one
UPDATE sys_setting
SET market_fetch_schedule_enabled = sqlc.arg(market_fetch_schedule_enabled),
    market_fetch_last_interval_minutes = sqlc.arg(market_fetch_last_interval_minutes),
    market_fetch_settlement_enabled = sqlc.arg(market_fetch_settlement_enabled),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, market_fetch_schedule_enabled, market_fetch_last_interval_minutes,
          market_fetch_settlement_enabled, market_fetch_last_run_at,
          market_fetch_last_summary, inserted_at, updated_at;

-- name: RecordMarketFetch :one
UPDATE sys_setting
SET market_fetch_last_run_at = date_trunc('second', now() AT TIME ZONE 'utc'),
    market_fetch_last_summary = sqlc.arg(summary),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE id = sqlc.arg(id)
RETURNING id, market_fetch_schedule_enabled, market_fetch_last_interval_minutes,
          market_fetch_settlement_enabled, market_fetch_last_run_at,
          market_fetch_last_summary, inserted_at, updated_at;
