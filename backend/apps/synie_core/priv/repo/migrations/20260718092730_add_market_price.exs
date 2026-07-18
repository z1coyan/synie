defmodule SynieCore.Repo.Migrations.AddMarketPrice do
  @moduledoc """
  行情品种 + 行情价点表;种子预置沪铜/长江铜/沪铝/沪银(无价点)。
  """

  use Ecto.Migration

  def up do
    create table(:bas_market_instrument, primary_key: false) do
      add :id, :uuid, null: false, default: fragment("gen_random_uuid()"), primary_key: true
      add :code, :text, null: false
      add :name, :text, null: false
      add :source_type, :text, null: false
      add :default_price_kind, :text, null: false
      add :active, :boolean, null: false, default: true
      add :note, :text

      add :inserted_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :updated_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :currency_id,
          references(:bas_currency,
            column: :id,
            name: "bas_market_instrument_currency_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false

      add :unit_id,
          references(:bas_unit,
            column: :id,
            name: "bas_market_instrument_unit_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false
    end

    create unique_index(:bas_market_instrument, [:code],
             name: "bas_market_instrument_unique_code_index"
           )

    create table(:bas_market_price_point, primary_key: false) do
      add :id, :uuid, null: false, default: fragment("gen_random_uuid()"), primary_key: true
      add :observed_at, :utc_datetime, null: false
      add :price, :decimal, null: false
      add :price_kind, :text, null: false
      add :source, :text, null: false, default: "manual"
      add :is_voided, :boolean, null: false, default: false
      add :note, :text

      add :inserted_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :updated_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :instrument_id,
          references(:bas_market_instrument,
            column: :id,
            name: "bas_market_price_point_instrument_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false

      add :currency_id,
          references(:bas_currency,
            column: :id,
            name: "bas_market_price_point_currency_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false

      add :unit_id,
          references(:bas_unit,
            column: :id,
            name: "bas_market_price_point_unit_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false
    end

    create unique_index(:bas_market_price_point, [:instrument_id, :observed_at, :price_kind],
             name: "bas_market_price_point_unique_active_point_index",
             where: "(is_voided = false)"
           )

    # --- 种子:CNY + 吨(若不存在) + 四品种(无价点) ---
    # 本币兜底(与销售订单币种迁移同口径)
    execute("""
    INSERT INTO bas_currency (name, iso_code, symbol)
    SELECT '人民币', 'CNY', '￥'
    WHERE NOT EXISTS (SELECT 1 FROM bas_currency WHERE iso_code = 'CNY')
    """)

    # 计量单位「吨」:优先复用 symbol 为 t/吨 的已有单位;否则在无 weight 基准时建基准吨,
    # 已有 weight 基准则建 ratio=1000 相对 kg 的近似(仅兜底,用户可后改)
    execute("""
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
    )
    """)

    execute("""
    INSERT INTO bas_market_instrument
      (code, name, source_type, default_price_kind, active, currency_id, unit_id)
    SELECT v.code, v.name, v.source_type, v.default_price_kind, true,
           (SELECT id FROM bas_currency WHERE iso_code = 'CNY' LIMIT 1),
           (SELECT id FROM bas_unit WHERE symbol IN ('t', '吨') OR name = '吨' ORDER BY symbol LIMIT 1)
    FROM (VALUES
      ('SHFE_CU', '沪铜', 'exchange', 'settlement'),
      ('CJ_CU', '长江铜', 'spot_index', 'average'),
      ('SHFE_AL', '沪铝', 'exchange', 'settlement'),
      ('SHFE_AG', '沪银', 'exchange', 'settlement')
    ) AS v(code, name, source_type, default_price_kind)
    WHERE NOT EXISTS (
      SELECT 1 FROM bas_market_instrument i WHERE i.code = v.code
    )
    AND EXISTS (SELECT 1 FROM bas_currency WHERE iso_code = 'CNY')
    AND EXISTS (SELECT 1 FROM bas_unit WHERE symbol IN ('t', '吨') OR name = '吨')
    """)
  end

  def down do
    drop_if_exists unique_index(
                     :bas_market_price_point,
                     [:instrument_id, :observed_at, :price_kind],
                     name: "bas_market_price_point_unique_active_point_index"
                   )

    drop constraint(:bas_market_price_point, "bas_market_price_point_instrument_id_fkey")
    drop constraint(:bas_market_price_point, "bas_market_price_point_currency_id_fkey")
    drop constraint(:bas_market_price_point, "bas_market_price_point_unit_id_fkey")
    drop table(:bas_market_price_point)

    drop_if_exists unique_index(:bas_market_instrument, [:code],
                     name: "bas_market_instrument_unique_code_index"
                   )

    drop constraint(:bas_market_instrument, "bas_market_instrument_currency_id_fkey")
    drop constraint(:bas_market_instrument, "bas_market_instrument_unit_id_fkey")
    drop table(:bas_market_instrument)
  end
end
