defmodule SynieCore.Repo.Migrations.MarketShfeAgUnitKg do
  @moduledoc """
  沪银(SHFE_AG)报价口径是元/千克,不是元/吨。
  补千克单位(若无),并把沪银品种及其已有价点改挂千克。
  """
  use Ecto.Migration

  def up do
    # 千克:与现有重量基准对齐。若「吨」为基准(ratio=1)则 kg.ratio=0.001;
    # 若已有 kg 则复用。
    execute("""
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
        WHEN EXISTS (
          SELECT 1 FROM bas_unit WHERE unit_type = 'weight' AND is_base = true
        ) THEN 1
        ELSE 1
      END
    WHERE NOT EXISTS (
      SELECT 1 FROM bas_unit WHERE symbol IN ('kg', '千克') OR name IN ('千克', '公斤')
    )
    """)

    # 品种 unit 创建后业务上钉死,此处数据订正走 SQL
    execute("""
    UPDATE bas_market_instrument i
    SET unit_id = u.id,
        updated_at = NOW()
    FROM bas_unit u
    WHERE i.code = 'SHFE_AG'
      AND (u.symbol IN ('kg', '千克') OR u.name IN ('千克', '公斤'))
    """)

    # 已落库价点的单位随品种订正(价点继承字段,不应与品种口径不一致)
    execute("""
    UPDATE bas_market_price_point p
    SET unit_id = i.unit_id,
        updated_at = NOW()
    FROM bas_market_instrument i
    WHERE p.instrument_id = i.id
      AND i.code = 'SHFE_AG'
    """)
  end

  def down do
    # 回滚到吨(若存在);仅恢复品种与价点挂接,不删千克单位
    execute("""
    UPDATE bas_market_instrument i
    SET unit_id = u.id,
        updated_at = NOW()
    FROM bas_unit u
    WHERE i.code = 'SHFE_AG'
      AND (u.symbol IN ('t', '吨') OR u.name = '吨')
    """)

    execute("""
    UPDATE bas_market_price_point p
    SET unit_id = i.unit_id,
        updated_at = NOW()
    FROM bas_market_instrument i
    WHERE p.instrument_id = i.id
      AND i.code = 'SHFE_AG'
    """)
  end
end
