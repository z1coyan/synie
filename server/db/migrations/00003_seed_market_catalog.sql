-- +goose Up
-- schema-only baseline 不含旧 Ecto 行情种子；全部按自然键幂等补齐，保留已有主数据。
INSERT INTO bas_currency (name, iso_code, symbol)
SELECT '人民币', 'CNY', '￥'
WHERE NOT EXISTS (SELECT 1 FROM bas_currency WHERE iso_code = 'CNY');

INSERT INTO bas_unit (unit_type, is_base, name, symbol, ratio)
SELECT
  'weight',
  NOT EXISTS (SELECT 1 FROM bas_unit WHERE unit_type = 'weight' AND is_base = true),
  '吨',
  't',
  CASE
    WHEN EXISTS (SELECT 1 FROM bas_unit WHERE unit_type = 'weight' AND is_base = true)
      THEN 1000
    ELSE 1
  END
WHERE NOT EXISTS (
  SELECT 1 FROM bas_unit WHERE symbol IN ('t', '吨') OR name = '吨'
);

INSERT INTO bas_unit (unit_type, is_base, name, symbol, ratio)
SELECT
  'weight',
  false,
  '千克',
  'kg',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM bas_unit
      WHERE unit_type = 'weight' AND is_base = true AND symbol IN ('t', '吨')
    ) THEN 0.001
    ELSE 1
  END
WHERE NOT EXISTS (
  SELECT 1 FROM bas_unit WHERE symbol IN ('kg', '千克') OR name IN ('千克', '公斤')
);

INSERT INTO bas_market_instrument
  (code, name, source_type, default_price_kind, active, fetch_enabled,
   external_last_code, external_product_group, currency_id, unit_id)
SELECT v.code, v.name, v.source_type, v.default_price_kind, true, v.fetch_enabled,
       v.last_code, v.product_group,
       (SELECT id FROM bas_currency WHERE iso_code = 'CNY' LIMIT 1),
       (SELECT id FROM bas_unit
        WHERE CASE WHEN v.unit_kind = 'kg'
          THEN symbol IN ('kg', '千克') OR name IN ('千克', '公斤')
          ELSE symbol IN ('t', '吨') OR name = '吨'
        END
        ORDER BY symbol LIMIT 1)
FROM (VALUES
  ('SHFE_CU', '沪铜', 'exchange', 'settlement', 't', true, 'CU0', 'cu'),
  ('CJ_CU', '长江铜', 'spot_index', 'average', 't', false, NULL, NULL),
  ('SHFE_AL', '沪铝', 'exchange', 'settlement', 't', true, 'AL0', 'al'),
  ('SHFE_AG', '沪银', 'exchange', 'settlement', 'kg', true, 'AG0', 'ag')
) AS v(code, name, source_type, default_price_kind, unit_kind, fetch_enabled, last_code, product_group)
WHERE NOT EXISTS (
  SELECT 1 FROM bas_market_instrument i WHERE i.code = v.code
)
AND EXISTS (SELECT 1 FROM bas_currency WHERE iso_code = 'CNY')
AND EXISTS (SELECT 1 FROM bas_unit WHERE symbol IN ('t', '吨') OR name = '吨')
AND (
  v.unit_kind <> 'kg'
  OR EXISTS (SELECT 1 FROM bas_unit WHERE symbol IN ('kg', '千克') OR name IN ('千克', '公斤'))
);

-- +goose Down
-- no-op：行情品种可能已被价点引用，回滚不得删除或覆盖真实主数据。
SELECT 1;
